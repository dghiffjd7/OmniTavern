import { tableMatchesMemoryContext } from './memory-context-utils.js';
import { buildMemoryEditGuide } from './memory-edit-guide.js';
import { formatMemoryPromptText } from './memory-prompt-locale.js';
import { OUTLINE_SECTION_LABELS, getOutlineSectionLabel, isOutlineTableId } from './outline-section-utils.js';
import { translateUiText as t } from '../i18n/index.js';

const ownText = (fields, key, fallback) => typeof fields?.[key] === 'string' ? fields[key] : String(fallback ?? '');
const RULE_LABELS = { note:'表格说明', initNode:'初始化指导', insertNode:'新增指导', updateNode:'更新指导', deleteNode:'删除指导' };
const GUIDE_LABELS = {
  required_header:'必填项标题', summary_mode:'仅摘要更新', standard_mode:'普通表格更新', summary_insert_only:'摘要写入指导',
  outline_sections:'大纲分节指导', outline_upsert:'大纲更新指导', outline_fallback:'大纲兜底指导', output_instruction:'输出指导',
  format_example:'示例标题', sample_insert:'新增示例', sample_update:'更新示例', sample_delete:'删除示例',
  json_line_only:'逐行格式', empty_table_insert:'空表指导', valid_row_index:'行号约束', row_index_help:'行号说明',
  no_changes:'无变更指导', worldbook_boundary:'记忆与设定边界', keywords_required:'关键词填写', keywords_usage:'关键词用途', table_index:'表格索引标题',
};

// Presentation copies only. Table/column IDs, rows, scopes and update policies
// always come from the template and chat stores, never from the prompt editor.
export const applyMemoryPromptFields = (tables, fields = {}) => {
  if (!Object.keys(fields || {}).length) return tables || [];
  return (tables || []).map(table => ({
    ...table,
    name: ownText(fields, `table:${table.id}:name`, table.name),
    columns: (table.columns || []).map(column => ({ ...column, name:ownText(fields, `table:${table.id}:column:${column.id}`, column.name) })),
    sourceData: { ...(table.sourceData || table.source_data || {}),
      ...Object.fromEntries(Object.keys(RULE_LABELS).map(key => [key, ownText(fields, `table:${table.id}:rule:${key}`, (table.sourceData || table.source_data)?.[key])])),
    },
    promptOutlineLabels: Object.fromEntries(Object.keys(OUTLINE_SECTION_LABELS).map(key => [key, ownText(fields, `outline:${key}`, getOutlineSectionLabel(key))])),
  }));
};

export const buildMemoryPromptEditorFields = (record, context = null) => {
  const values = record?.injection?.promptFields || {};
  const tables = (record?.schema?.tables || []).filter(table => !context || tableMatchesMemoryContext(table, context))
    .filter(table => !context || !table.scope || table.scope === 'global' || (table.scope === 'group' ? context.isGroup : !context.isGroup));
  const fields = [], seen = new Set();
  const add = (id, label, value, group) => {
    if (seen.has(id)) return;
    seen.add(id); fields.push({ id, label:t(label), defaultValue:String(value ?? ''), value:ownText(values,id,value), group });
  };
  for (const updateMode of ['full', 'summary', 'standard']) buildMemoryEditGuide({ updateMode, tableOrder:tables.map(table => table.id), tableById:new Map(tables.map(table => [table.id,table])), requiredHints:[''],
    promptFields:values, onField:field => add(field.id,GUIDE_LABELS[field.id.slice(6)] || field.id,field.defaultValue,t('通用写表指导')) });
  for (const [key,label] of Object.entries({missing_fields:'缺失字段指导',summary_required:'摘要必写指导',outline_check:'大纲检查指导'})) {
    add(`guide:${key}`,label,formatMemoryPromptText(`memory.edit.${key}`),t('通用写表指导'));
  }
  for (const table of tables) {
    const group = table.name || table.id;
    add(`table:${table.id}:name`, '表格显示名称', table.name, group);
    for (const column of table.columns || []) add(`table:${table.id}:column:${column.id}`, column.name || column.id, column.name, group);
    for (const [key,label] of Object.entries(RULE_LABELS)) add(`table:${table.id}:rule:${key}`,label,(table.sourceData || table.source_data)?.[key],group);
  }
  if (tables.some(table => isOutlineTableId(table.id))) for (const key of Object.keys(OUTLINE_SECTION_LABELS)) add(`outline:${key}`,getOutlineSectionLabel(key),getOutlineSectionLabel(key),t('大纲分节显示名称'));
  return fields;
};

export const normalizeMemoryAgentPromptConfig = (record = null, context = null) => {
  const injection = record?.injection || {};
  return {
    templateId:String(record?.id || ''), templateName:String(record?.name || '默认记忆模板'),
    sessionId:String(context?.sessionId || ''), scopeId:String(context?.scopeId || ''),
    template:typeof injection.template === 'string' ? injection.template : '{{tableData}}',
    wrapper:typeof injection.wrapper === 'string' ? injection.wrapper : '<memories>\n{{tableData}}\n</memories>',
    position:String(injection.position || 'before_latest_user'),
    fields:buildMemoryPromptEditorFields(record,context),
  };
};

export const mergeMemoryPromptDraft = (record, config = {}) => {
  const injection = { ...(record?.injection || {}) };
  for (const key of ['template','wrapper','position']) if (typeof config[key] === 'string') injection[key] = config[key];
  const allowed = new Map(buildMemoryPromptEditorFields(record).map(field => [field.id,field]));
  const promptFields = { ...(injection.promptFields || {}) };
  for (const [id,value] of Object.entries(config.promptFields || {})) {
    const field = allowed.get(id);
    if (!field || typeof value !== 'string') continue;
    if (value.length > 20000) throw new Error('提示词区块过长，请缩小内容');
    if (value === field.defaultValue) delete promptFields[id]; else promptFields[id] = value;
  }
  if (Object.keys(promptFields).length) injection.promptFields = promptFields;
  else delete injection.promptFields;
  return { ...record, injection };
};
