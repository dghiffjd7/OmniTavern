import { t } from '../../i18n/index.js';

const MAX_HINTS = 5;
const trim = value => String(value ?? '').trim();
const normalize = value => trim(value).normalize('NFKC').toLowerCase();
// Only explicit copy/number suffixes qualify. A common prefix or spelling
// distance never changes the deletion plan or produces a suggestion.
const suffix = /(?:\s*[([]\s*(?:副本|copy)(?:\s*[-_]?\s*\d{1,6})?\s*[)\]]|\s*[([]\s*\d{1,6}\s*[)\]]|(?:\s+|[-_]\s*)(?:copy|副本)(?:\s*[-_]?\s*\d{1,6})?|\s*副本(?:\s*\d{1,6})?|(?:\s+|[-_]\s*)\d{1,6})$/iu;
const nameKey = value => {
  let name = normalize(value);
  for (let depth = 0; depth < 3; depth += 1) {
    const base = name.replace(suffix, '').trim();
    if (!base || base === name) break;
    name = base;
  }
  return name.replace(/\s+/gu, '');
};

/** Advisory names from the store index. Never resolve targets using these keys. */
export const findKeptSimilarWorldbooks = ({ storedIds = [], items = [] } = {}) => {
  const selectedIds = new Set(items.map(item => trim(item.worldbookId)).filter(Boolean));
  const targetKeys = new Set(items.filter(item => item.status === 'planned')
    .flatMap(item => [nameKey(item.worldbookId), nameKey(item.name)]).filter(Boolean));
  const matches = [...new Set(storedIds.map(trim).filter(Boolean))]
    .filter(id => !selectedIds.has(id) && targetKeys.has(nameKey(id)));
  return {
    count: matches.length,
    items: matches.slice(0, MAX_HINTS).map(id => ({ id, name: id })),
    truncated: matches.length > MAX_HINTS,
  };
};

export const formatKeptSimilarWorldbooks = (hint = {}) => {
  if (!hint.count) return '';
  const names = hint.items.map(item => `「${item.name}」`).join('、');
  return hint.truncated
    ? t('另有 {count} 本未选中的近似名世界书，将保留；其中包括：{names}。', { count: hint.count, names })
    : t('另有未选中的近似名世界书：{names}。这些世界书将保留。', { names });
};
