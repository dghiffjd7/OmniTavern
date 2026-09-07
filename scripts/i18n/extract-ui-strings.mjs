import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractHanLiterals } from './scan-hardcoded.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../..');
const UI_ROOT = path.join(PROJECT_ROOT, 'src/scripts/ui');
const MANUAL_SOURCE_FILE = path.join(PROJECT_ROOT, 'scripts/i18n/manual-ui-source-keys.json');
const EXTRA_UI_FILES = [
  path.join(PROJECT_ROOT, 'src/scripts/storage/realtime-profile-store.js'),
  path.join(PROJECT_ROOT, 'src/scripts/agent/agent-feature-settings.js'),
  path.join(PROJECT_ROOT, 'src/scripts/memory/default-template.js'),
  path.join(PROJECT_ROOT, 'src/scripts/memory/outline-section-utils.js'),
  path.join(PROJECT_ROOT, 'src/scripts/variables/variable-templates.js'),
];
const FULL_UI_DEFINITION_FILES = new Set([
  path.join(PROJECT_ROOT, 'src/scripts/ui/realtime/realtime-call-panel.js'),
  path.join(PROJECT_ROOT, 'src/scripts/ui/realtime/realtime-settings-panel.js'),
  path.join(PROJECT_ROOT, 'src/scripts/ui/realtime/realtime-enrollment-view.js'),
  path.join(PROJECT_ROOT, 'src/scripts/ui/realtime/realtime-provider-catalog.js'),
  path.join(PROJECT_ROOT, 'src/scripts/ui/realtime/realtime-voice-catalog.js'),
  path.join(PROJECT_ROOT, 'src/scripts/ui/realtime/realtime-voice-picker.js'),
  path.join(PROJECT_ROOT, 'src/scripts/ui/realtime/realtime-voice-enrollment.js'),
  path.join(PROJECT_ROOT, 'src/scripts/storage/realtime-profile-store.js'),
  path.join(PROJECT_ROOT, 'src/scripts/agent/agent-feature-settings.js'),
  path.join(PROJECT_ROOT, 'src/scripts/memory/default-template.js'),
  path.join(PROJECT_ROOT, 'src/scripts/memory/outline-section-utils.js'),
  path.join(UI_ROOT, 'agent-center-card-catalog.js'),
  path.join(UI_ROOT, 'maid-guide-spotlight.js'),
  path.join(UI_ROOT, 'maid-intent-presets.js'),
  path.join(UI_ROOT, 'maid-onboarding-entry-ui.js'),
  path.join(UI_ROOT, 'maid-onboarding-flows.js'),
  path.join(UI_ROOT, 'maid-onboarding-runtime.js'),
]);
const HAN_RE = /\p{Script=Han}/u;
const TEMPLATE_SLOT = '\u0000';
const UI_MARKUP_RE = /<(?:a|article|aside|button|details|div|footer|h[1-6]|header|img|label|li|main|nav|option|p|section|select|small|span|strong|summary|textarea|ul)\b|<(?:input|textarea|select)\b[^>]*(?:aria-label|placeholder|title)\s*=/i;
const DOM_ASSIGNMENT_CONTEXT_RE = /(?:textContent|innerText|ariaLabel|placeholder)\s*=\s*$/;
const UI_PROPERTY_CONTEXT_RE = /(?:title|label|description|message|confirmText|cancelText|placeholder|emptyText|helpText|subtitle|statusText)\s*:\s*$/;
const UI_CALL_CONTEXT_RE = /(?:(?:toastr\?*\.(?:success|error|warning|info)|toastr\[[^\]]+\])(?:\?\.)?|(?<![\w$])t(?:\?\.)?)\(\s*$/;
const FOLD_LABEL_CONTEXT_RE = /renderFoldButton\(\s*s\s*,\s*$/;
const UI_BUILDER_LINE_RE = /\bmake(?:Number|Select|Text|Textarea|Toggle)\s*\(/;
const HTML_EXTRACTION_NOISE_RE = /(?:['"]\s*,\s*['"]|\/\/|\b(?:const|let|return)\b|<%|image_prompt|summary_format|\[img-|<prompt>|<input>|包裹在|title\/meta\/base|）或自闭（|\/ 原聊天行 \/)/i;

const EXCLUDED_FILE_PATTERNS = [
  /\/vendor\//,
  /theme-dark-batch-audit\.js$/,
];

const PROTOCOL_ONLY_PATTERNS = [
  /^<\/?(?:群聊|私聊|content|tableEdit|image_prompt)/i,
  /^(?:moment_reply_start|moment_start|MiPhone_start|msg_start|reply_to::)$/i,
];

const normalizeCandidate = (value = '') => String(value || '')
  .replace(/\\n/g, '\n')
  .replace(/\\r/g, '\r')
  .replace(/\\t/g, '\t')
  .replace(/\\([\\'"`])/g, '$1')
  .trim();

const getTemplateShape = value => String(value || '')
  .replace(/(?<!\{)\{[a-zA-Z0-9_.-]+\}(?!\})/g, TEMPLATE_SLOT)
  .replace(new RegExp(`${TEMPLATE_SLOT}+`, 'g'), TEMPLATE_SLOT);

const materializeTemplateSlots = (value = '') => {
  let index = 0;
  return String(value || '').replaceAll(TEMPLATE_SLOT, () => {
    index += 1;
    return index === 1 ? '{value}' : `{value${index}}`;
  });
};

const isUiCandidate = (value = '') => {
  const text = normalizeCandidate(value);
  if (!text || !HAN_RE.test(text)) return false;
  if (text.length > 240 || text.split('\n').length > 4) return false;
  if (text.includes('${')) return false;
  if (PROTOCOL_ONLY_PATTERNS.some(pattern => pattern.test(text))) return false;
  return true;
};

const addMatch = (map, value, file, kind) => {
  const normalized = normalizeCandidate(value);
  let text = kind === 'html-text' ? normalized.replace(/\s+/g, ' ').trim() : normalized;
  if (text.includes(TEMPLATE_SLOT)) {
    const shape = getTemplateShape(text);
    const existing = Array.from(map.values()).find(entry => getTemplateShape(entry.source) === shape);
    text = existing?.source || materializeTemplateSlots(text);
  }
  if (!isUiCandidate(text)) return;
  if (!map.has(text)) map.set(text, { source: text, references: [] });
  const entry = map.get(text);
  const ref = `${path.relative(PROJECT_ROOT, file).replace(/\\/g, '/')}#${kind}`;
  if (!entry.references.includes(ref)) entry.references.push(ref);
};

const collectMatches = (map, source, file, regex, groupIndex, kind) => {
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(source))) addMatch(map, match[groupIndex], file, kind);
};

const readQuotedLiteral = (source, start) => {
  const quote = source[start];
  if (quote !== '\'' && quote !== '"') return null;
  let value = '';
  let cursor = start + 1;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '\n' || char === '\r') return null;
    if (char === '\\') {
      value += source[cursor + 1] === 'n' ? ' ' : source[cursor + 1] || '';
      cursor += 2;
      continue;
    }
    if (char === quote) return { value, end: cursor + 1 };
    value += char;
    cursor += 1;
  }
  return null;
};

const collectQuotedAfterPrefix = (map, source, file, prefixRegex, kind) => {
  prefixRegex.lastIndex = 0;
  let match;
  while ((match = prefixRegex.exec(source))) {
    let cursor = prefixRegex.lastIndex;
    while (/\s/.test(source[cursor] || '')) cursor += 1;
    const literal = readQuotedLiteral(source, cursor);
    if (!literal) continue;
    addMatch(map, literal.value, file, kind);
    prefixRegex.lastIndex = literal.end;
  }
};

const collectHtmlMatches = (map, source, file) => {
  const htmlTextRegex = />([\t\r\n ]*[^<>{}`;=]*\p{Script=Han}[^<>{}`;=]*?)[\t\r\n ]*<(?=[!/A-Za-z])/gu;
  htmlTextRegex.lastIndex = 0;
  let textMatch;
  while ((textMatch = htmlTextRegex.exec(source))) {
    if (!HTML_EXTRACTION_NOISE_RE.test(textMatch[1])) addMatch(map, textMatch[1], file, 'html-text');
  }
  collectMatches(
    map,
    source,
    file,
    /(?:aria-label|placeholder|title|data-help)\s*=\s*["']([^"'\n]*\p{Script=Han}[^"'\n]*)["']/gu,
    1,
    'html-attribute',
  );
};

const extractFromSource = (source, file, map) => {
  collectHtmlMatches(map, source, file);
  if (file.endsWith('.html')) return;

  collectQuotedAfterPrefix(
    map,
    source,
    file,
    /(?:textContent|innerText|ariaLabel|placeholder)\s*=\s*/gu,
    'dom-assignment',
  );
  collectQuotedAfterPrefix(
    map,
    source,
    file,
    /(?:title|label|description|message|confirmText|cancelText|placeholder|emptyText|helpText|subtitle|statusText)\s*:\s*/gu,
    'ui-property',
  );
  collectQuotedAfterPrefix(
    map,
    source,
    file,
    /(?:(?:toastr\?*\.(?:success|error|warning|info)|toastr\[[^\]]+\])(?:\?\.)?|(?<![\w$])t(?:\?\.)?)\(\s*/gu,
    'ui-call',
  );
  collectQuotedAfterPrefix(
    map,
    source,
    file,
    /renderFoldButton\(\s*(?:'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")\s*,\s*/gu,
    'fold-label',
  );
  if (FULL_UI_DEFINITION_FILES.has(file)) {
    collectMatches(map, source, file, /'([^'\n]*?\p{Script=Han}[^'\n]*?)'/gu, 1, 'ui-definition');
    collectMatches(map, source, file, /"([^"\n]*?\p{Script=Han}[^"\n]*?)"/gu, 1, 'ui-definition');
  }

  source.split(/\r?\n/).forEach((line) => {
    const items = extractHanLiterals(line);
    if (UI_BUILDER_LINE_RE.test(line)) {
      items.forEach(item => addMatch(map, item.text, file, 'ui-builder'));
    }
    items.filter(item => item.template).forEach((item) => {
      const context = String(item.context || '');
      const literalText = String(item.text || '').replace(/\s+/g, ' ').trim();
      const containsUiMarkup = UI_MARKUP_RE.test(item.text);
      if (containsUiMarkup) collectHtmlMatches(map, item.text, file);
      if (!containsUiMarkup && DOM_ASSIGNMENT_CONTEXT_RE.test(context)) addMatch(map, literalText, file, 'dom-assignment');
      if (!containsUiMarkup && UI_PROPERTY_CONTEXT_RE.test(context)) addMatch(map, literalText, file, 'ui-property');
      if (!containsUiMarkup && UI_CALL_CONTEXT_RE.test(context)) addMatch(map, literalText, file, 'ui-call');
      if (!containsUiMarkup && FOLD_LABEL_CONTEXT_RE.test(context)) addMatch(map, literalText, file, 'fold-label');
    });
  });
};

const walkJsFiles = async (root) => {
  const output = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...await walkJsFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.js')) output.push(fullPath);
  }
  return output;
};

export const extractUiStrings = async () => {
  const files = [path.join(PROJECT_ROOT, 'src/index.html'), ...await walkJsFiles(UI_ROOT), ...EXTRA_UI_FILES]
    .filter(file => !EXCLUDED_FILE_PATTERNS.some(pattern => pattern.test(file.replace(/\\/g, '/'))));
  const map = new Map();
  const manualSources = JSON.parse(await fs.readFile(MANUAL_SOURCE_FILE, 'utf8'));
  manualSources.forEach(source => addMatch(map, source, MANUAL_SOURCE_FILE, 'manual'));
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    extractFromSource(source, file, map);
  }
  return Array.from(map.values())
    .map(entry => ({ ...entry, references: entry.references.sort() }))
    .sort((a, b) => a.source.localeCompare(b.source, 'zh-Hans-CN'));
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entries = await extractUiStrings();
  const outputPath = path.join(PROJECT_ROOT, 'scripts/i18n/ui-source-catalog.json');
  await fs.writeFile(outputPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  console.log(`i18n extract: ${entries.length} UI strings -> ${path.relative(PROJECT_ROOT, outputPath)}`);
}
