import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { initializeI18n, translateUiText } from '../../src/scripts/i18n/index.js';
import { setPromptLocale } from '../../src/scripts/i18n/prompt-locale.js';
import englishPrompts from '../../src/scripts/i18n/prompt-locales/en.js';
import { DEFAULT_MEMORY_TEMPLATE } from '../../src/scripts/memory/default-template.js';
import {
  buildContactProfileHeader,
  buildContactProfileWeakTriggerPrompt,
} from '../../src/scripts/memory/contact-profile-utils.js';
import { buildMemoryEditGuide } from '../../src/scripts/memory/memory-edit-guide.js';
import { buildMemoryKeywordRecallPlan } from '../../src/scripts/memory/memory-keyword-recall-utils.js';
import {
  canonicalizeOfficialMemoryTemplateRecord,
  localizeOfficialMemoryTemplateRecord,
} from '../../src/scripts/memory/memory-template-locale.js';
import { buildMemoryTablePlan, formatMemoryRowText } from '../../src/scripts/memory/memory-prompt-utils.js';

const english = JSON.parse(await fs.readFile('scripts/i18n/en.base.json', 'utf8'));
const uiSourceCatalog = JSON.parse(await fs.readFile('scripts/i18n/ui-source-catalog.json', 'utf8'));
const fullyLocalizedDefinitionFiles = [
  'src/scripts/memory/default-template.js',
  'src/scripts/memory/outline-section-utils.js',
  'src/scripts/ui/maid-guide-spotlight.js',
  'src/scripts/ui/maid-onboarding-entry-ui.js',
  'src/scripts/ui/maid-onboarding-flows.js',
  'src/scripts/ui/maid-onboarding-runtime.js',
];
for (const entry of uiSourceCatalog) {
  if (!entry.references.some(reference => fullyLocalizedDefinitionFiles.some(
    file => reference.startsWith(`${file}#`),
  ))) continue;
  assert.equal(
    typeof english[entry.source],
    'string',
    `English must cover the complete memory/maid definition surface: ${entry.source}`,
  );
}
for (const [key, value] of Object.entries(englishPrompts)) {
  if (!key.startsWith('memory.')) continue;
  assert.doesNotMatch(value, /\p{Script=Han}/u, `English memory prompt must not contain Han text: ${key}`);
}
await initializeI18n({
  preference: 'en',
  documentLike: null,
  fetchFn: async () => ({ ok: true, json: async () => english }),
});
setPromptLocale('en');

const record = {
  id: DEFAULT_MEMORY_TEMPLATE.meta.id,
  name: DEFAULT_MEMORY_TEMPLATE.meta.name,
  author: DEFAULT_MEMORY_TEMPLATE.meta.author,
  version: DEFAULT_MEMORY_TEMPLATE.meta.version,
  description: DEFAULT_MEMORY_TEMPLATE.meta.description,
  schema: structuredClone({
    meta: DEFAULT_MEMORY_TEMPLATE.meta,
    tables: DEFAULT_MEMORY_TEMPLATE.tables,
  }),
  injection: structuredClone(DEFAULT_MEMORY_TEMPLATE.injection),
  is_default: true,
  is_builtin: true,
};

const localized = localizeOfficialMemoryTemplateRecord(record);
assert.equal(localized.name, 'General Memory Template');
assert.equal(localized.schema.meta.author, 'Official');
assert.equal(localized.schema.tables.find(table => table.id === 'character_profile')?.name, 'Character Profile');
assert.equal(
  localized.schema.tables.find(table => table.id === 'character_profile')?.columns.find(column => column.id === 'personality')?.name,
  'Personality (MBTI, etc.)',
);
assert.equal(
  localized.schema.tables.find(table => table.id === 'chat_summary')?.sourceData.insertNode,
  'Insert one new summary after every conversation turn (required).',
);
assert.deepEqual(
  localized.schema.tables.find(table => table.id === 'important_people')?.columns.find(column => column.id === 'present')?.options,
  ['是', '否'],
  'stored enum values remain canonical while their UI labels are localized by the renderer',
);

const promptFacingValues = [];
promptFacingValues.push(
  localized.name,
  localized.author,
  localized.description,
  localized.schema.meta.name,
  localized.schema.meta.author,
  localized.schema.meta.description,
);
for (const table of localized.schema.tables) {
  promptFacingValues.push(table.name);
  promptFacingValues.push(...Object.values(table.sourceData || {}));
  promptFacingValues.push(...(table.columns || []).map(column => column.name));
}
assert.equal(
  promptFacingValues.some(value => /\p{Script=Han}/u.test(String(value || ''))),
  false,
  'all official prompt-facing memory schema labels and instructions must be English',
);

const canonicalized = canonicalizeOfficialMemoryTemplateRecord(localized);
assert.equal(canonicalized.name, DEFAULT_MEMORY_TEMPLATE.meta.name);
assert.equal(canonicalized.schema.tables[1].sourceData.note, DEFAULT_MEMORY_TEMPLATE.tables[1].sourceData.note);

const customized = structuredClone(record);
customized.schema.tables[1].name = '我的自定义角色表';
assert.equal(
  localizeOfficialMemoryTemplateRecord(customized).schema.tables[1].name,
  '我的自定义角色表',
  'user-modified official fields must not be mistaken for canonical built-in copy',
);
const userTemplate = { ...structuredClone(record), id: 'user-template', is_builtin: false };
assert.equal(localizeOfficialMemoryTemplateRecord(userTemplate).name, DEFAULT_MEMORY_TEMPLATE.meta.name);

const characterTable = localized.schema.tables.find(table => table.id === 'character_profile');
assert.equal(
  formatMemoryRowText({ personality: 'Calm' }, characterTable.columns, characterTable.id),
  'Personality (MBTI, etc.): Calm',
);
assert.equal(formatMemoryRowText({}, characterTable.columns, characterTable.id), '(Not filled in)');

const peopleTable = localized.schema.tables.find(table => table.id === 'important_people');
const peopleRowText = formatMemoryRowText(
  { name: 'Mira', present: '是' },
  peopleTable.columns,
  peopleTable.id,
);
assert.match(peopleRowText, /Present: Yes/);
assert.doesNotMatch(peopleRowText, /[是否]/u, 'canonical select values must be localized in the actual prompt');

const summaryTable = localized.schema.tables.find(table => table.id === 'chat_summary');
const plan = buildMemoryTablePlan({
  rows: [{ id: 'r1', table_id: 'chat_summary', row_data: { time: '第1轮', summary: 'Met at the station.' } }],
  tableById: new Map([[summaryTable.id, summaryTable]]),
  tableOrder: [summaryTable.id],
  autoExtract: true,
  maxRows: 10,
  tokenBudgetData: 1000,
  tokenMode: 'rough',
});
assert.match(plan.tableData, /Private Chat Summary/);
assert.match(plan.tableData, /Turn 1: Met at the station\./);
assert.doesNotMatch(plan.tableData, /\p{Script=Han}/u);

const recallPlan = buildMemoryKeywordRecallPlan({
  rows: [{
    id: 'recall-1',
    table_id: 'chat_summary',
    row_data: { time: '第1轮', summary: 'Met at the station.', keywords: 'station' },
  }],
  tableById: new Map([[summaryTable.id, summaryTable]]),
  queryText: 'station',
  tokenBudget: 1000,
  maxRows: 10,
  tokenMode: 'rough',
});
assert.match(recallPlan.text, /On-demand recall/);
assert.doesNotMatch(recallPlan.text, /\p{Script=Han}/u);

const profileHeader = buildContactProfileHeader({
  contact_id: 'aria',
  display_name: 'Aria',
  relationship: { current: 'Friend' },
  interaction_focus: ['travel'],
  stable_traits: [{ label: 'Calm' }],
  important_events: [{ label: 'Station meeting' }],
});
assert.doesNotMatch(profileHeader, /\p{Script=Han}/u);
const weakPrompt = buildContactProfileWeakTriggerPrompt({
  selectedSources: [{
    contactId: 'aria',
    name: 'Aria',
    score: 10,
    profileHeader,
    matchedRows: [{ tableName: 'Relationship History', rowSummary: 'Trusted friend.' }],
  }],
}, { settings: { injectProfileHeader: true, profileHeaderThreshold: 1 } });
assert.match(weakPrompt, /Moments weak trigger/);
assert.doesNotMatch(weakPrompt, /\p{Script=Han}/u);

const tableById = new Map(localized.schema.tables.map(table => [table.id, table]));
const guide = buildMemoryEditGuide({
  requiredHints: ['Complete the required profile fields.'],
  updateMode: 'full',
  tableOrder: ['character_profile', 'chat_summary', 'chat_outline'],
  tableById,
});
assert.match(guide, /<memory_edit_rules>/);
assert.match(guide, /Table index:/);
assert.match(guide, /Character Profile/);
assert.doesNotMatch(guide, /\p{Script=Han}/u, 'the guide included in the actual model request must be English');

for (const source of [
  '主人好呀，我是你的贴身女仆',
  '给女仆接上大脑',
  '主人还没给我接上大脑呢～要我带你把 API 配好吗？',
]) {
  const translated = translateUiText(source);
  assert.notEqual(translated, source, `maid onboarding text must have an English catalog entry: ${source}`);
  assert.doesNotMatch(translated, /\p{Script=Han}/u);
}

console.log('memory-template-locale-tests passed');
