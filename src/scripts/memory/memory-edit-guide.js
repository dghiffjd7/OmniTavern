import { isOutlineTableId } from './outline-section-utils.js';
import { isSummaryTableId } from './memory-prompt-utils.js';
import { formatMemoryPromptText } from './memory-prompt-locale.js';

export { formatMemoryPromptText } from './memory-prompt-locale.js';

export const buildMemoryEditGuide = ({
  requiredHints = [],
  updateMode = 'full',
  tableOrder = [],
  tableById = new Map(),
  promptFields = {},
  onField = null,
} = {}) => {
  const prompt = (key, fallback) => {
    const id = `guide:${key}`, defaultValue = formatMemoryPromptText(`memory.edit.${key}`, fallback);
    const value = typeof promptFields[id] === 'string' ? promptFields[id] : defaultValue;
    onField?.({ id, defaultValue, value });
    return value;
  };
  const lines = ['<memory_edit_rules>'];
  if (requiredHints.length) {
    lines.push(prompt('required_header', '【系统必填】'));
    requiredHints.forEach(hint => lines.push(`- ${hint}`));
  }
  if (updateMode === 'summary') {
    lines.push(prompt('summary_mode', '本轮仅允许更新“摘要/总体大纲”类表格，其他表格禁止写入。'));
  } else if (updateMode === 'standard') {
    lines.push(prompt('standard_mode', '本轮仅允许更新非摘要类表格，摘要/总体大纲类表格禁止写入。'));
  }
  if (tableOrder.some(tableId => isSummaryTableId(tableId) && !isOutlineTableId(tableId))) {
    lines.push(prompt('summary_insert_only', '摘要表格只允许 insert；禁止 update/delete。'));
  }
  if (tableOrder.some(tableId => isOutlineTableId(tableId))) {
    lines.push(prompt('outline_sections', '总体大纲采用分节覆盖：section 只允许 current、plot、relationships、open_threads；每轮只输出发生变化的分节。'));
    lines.push(prompt('outline_upsert', '大纲分节已存在时使用 update，不存在时使用 insert；不要逐轮新增大纲，也不要删除分节。'));
    lines.push(prompt('outline_fallback', '若无法判断分节，使用 section:"current" 作为全量重写兜底。'));
  }
  lines.push(prompt('output_instruction', '##在每次回复的末尾，按要求以规定格式，输出完整xml标签包裹tableEdit：'));
  lines.push(prompt('format_example', '（格式示例）'));
  lines.push('<tableEdit>');
  lines.push(prompt('sample_insert', '{"action":"insert","table_id":"relationship","data":{"relation":"朋友"}}'));
  lines.push(prompt('sample_update', '{"action":"update","table_id":"relationship","row_index":0,"data":{"relation":"亲密朋友"}}'));
  lines.push(prompt('sample_delete', '{"action":"delete","table_id":"relationship","row_index":0}'));
  lines.push('</tableEdit>');
  lines.push(prompt('json_line_only', '每行只允许一个 JSON 对象；不要使用其他语法。'));
  lines.push(prompt('empty_table_insert', '若该表当前无任何行，只能使用 insert；不要输出 update/delete。'));
  lines.push(prompt('valid_row_index', '仅当 row_index 对应现有行时才使用 update/delete。'));
  lines.push(prompt('row_index_help', 'row_index 对应表格中每行前的编号；table_id 见下表。'));
  lines.push(prompt('no_changes', '无修改则输出空 <tableEdit></tableEdit>。'));
  lines.push(prompt('worldbook_boundary', '世界书负责“设定是什么”；记忆表格只记录“当前状态如何、发生过什么”，不要把静态设定整段抄入表格。'));
  const keywordTableIds = tableOrder.filter((tableId) => (
    (tableById.get(tableId)?.columns || []).some(
      column => String(column?.id || '').trim() === 'keywords',
    )
  ));
  if (keywordTableIds.length) {
    lines.push(prompt('keywords_required', '带 keywords 列的表格在 insert 时必须填写召回关键词，update 时按内容变化同步维护；使用人物、地点、物品、事件等稳定名词，以逗号分隔，禁止写“这个/那件事”等模糊指代。'));
    lines.push(prompt('keywords_usage', 'keywords 仅供本地按需召回，不要把它写成摘要正文；旧行缺少 keywords 时由 app 在本地懒生成索引。'));
  }
  lines.push(prompt('table_index', '表格索引:'));
  tableOrder.forEach((tableId, index) => {
    const table = tableById.get(tableId) || { id: tableId, name: tableId, columns: [] };
    const cols = (table?.columns || [])
      .map((column) => {
        const id = String(column?.id || '').trim();
        const name = String(column?.name || '').trim();
        if (!id && !name) return '';
        if (id && name && id !== name) return `${id}:${name}`;
        return id || name;
      })
      .filter(Boolean)
      .join(', ');
    const scope = String(table?.scope || '').trim();
    const meta = [scope ? `scope:${scope}` : '', cols ? `cols:${cols}` : ''].filter(Boolean).join(', ');
    const label = String(table?.name || tableId);
    lines.push(`[${index}] ${label} (table_id:${tableId}${meta ? `, ${meta}` : ''})`);
    const sourceData = table?.sourceData || table?.source_data || {};
    const rules = [
      ['note', sourceData?.note],
      ['init', sourceData?.initNode],
      ['insert', sourceData?.insertNode],
      ['update', sourceData?.updateNode],
      ['delete', sourceData?.deleteNode],
    ];
    rules.forEach(([kind, value]) => {
      const text = String(value || '').trim();
      if (text) lines.push(`  - ${kind}: ${text}`);
    });
  });
  lines.push('</memory_edit_rules>');
  return lines.join('\n').trim();
};
