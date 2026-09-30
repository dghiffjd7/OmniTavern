import { t } from '../i18n/index.js';
import { buildMaidWorldbookObservationLedger } from './maid-worldbook-observations.js';

const trim = value => String(value ?? '').trim();
const clone = value => JSON.parse(JSON.stringify(value));
const forbidden = /取消|算了|停止|不(?:比较|对比|合并|并回)|(?:不要|别|不想|不打算|没让你|禁止).{0,24}(?:比较|对比|合并|并回|compare|merge)|\b(?:do not|don't|never|cancel|stop)\b/iu;
const request = /(?:^|[，,。；;！？!?\n])\s*(?:(?:请|麻烦|帮我|替我|给我)\s*)*(?:(?:把|将)[^，,。；;！？!?\n]{1,120}(?:比较|对比|合并|并回)|(?:比较|对比|合并|并回)\s*\S|(?:(?:please|can you|could you|would you)\s+)?(?:compare|merge)\s+\S)/iu;
const nonImperative = /(?:^|[，,。；;！？!?\n])\s*(?:(?:比较|对比|合并|并回)\s*(?:是什么|是什么意思|有什么意思|的意思)|(?:合并|并回)后的|(?:比较|对比)好看)/u;
const isRequest = input => request.test(trim(input)) && !forbidden.test(trim(input)) && !nonImperative.test(trim(input));
const mergeRequest = /(?:^|[，,。；;！？!?\n])\s*(?:(?:请|麻烦|帮我|替我|给我)\s*)*(?:(?:把|将)[^，,。；;！？!?\n]{1,120}(?:合并|并回)|(?:合并|并回)\s*\S|(?:(?:please|can you|could you|would you)\s+)?merge\s+\S)/iu;
const worldbookReference = /世界[书書]|\b(?:world\s*books?|lore\s*books?)\b/iu;
const mentionsObservedReference = (input, reference) => {
  const value = trim(reference);
  if (!value) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const prefix = /^[A-Za-z0-9_-]/u.test(value) ? '(?:^|[^A-Za-z0-9_-])' : '';
  const suffix = /[A-Za-z0-9_-]$/u.test(value) ? '(?=$|[^A-Za-z0-9_-])' : '';
  return new RegExp(`${prefix}${escaped}${suffix}`, 'u').test(input);
};
const fullEntry = entry => typeof entry?.content === 'string'
  && entry.contentTruncated === false && entry.presentationTruncated === false
  && entry.contentLength === entry.content.length;
const entryRef = (book, entry) => ({
  bookId: book.id, entryId: entry.id, title: entry.title,
  content: entry.content, sourceStep: entry.observedStep,
});
const getLedger = (steps, context) => buildMaidWorldbookObservationLedger({ steps, context, maxChars: 16000, maxBooks: 8 });
const bookRef = book => ({
  id: book.id, name: book.name, coverage: clone(book.coverage),
  sourceSteps: [...new Set(book.entries.map(entry => entry.observedStep))],
});

export const buildMaidWorldbookComparisonContext = ({ input = '', steps = [], context = {} } = {}) => {
  if (!isRequest(input)) return { eligible: false, autoPresentEligible: false, reason: 'not_comparison_request', books: [], needsSelection: false };
  const ledger = getLedger(steps, context), books = (ledger?.books || []).map(bookRef);
  const text = trim(input);
  const hasWorldbookTarget = worldbookReference.test(text)
    || books.some(book => mentionsObservedReference(text, book.name) || mentionsObservedReference(text, book.id));
  return {
    eligible: books.length >= 2,
    // A report may support an explicit comparison API call, but automatic
    // publication is narrower: incidental background reads cannot change a
    // character comparison into a worldbook merge proposal.
    autoPresentEligible: books.length >= 2 && mergeRequest.test(text) && hasWorldbookTarget,
    reason: books.length < 2 ? 'comparison_reads_missing' : '', books,
    omittedBooks: ledger?.omittedBooks || 0,
    needsSelection: books.length > 2 || Boolean(ledger?.omittedBooks),
  };
};

const groupByTitle = book => {
  const groups = new Map();
  for (const entry of book.entries) {
    const title = trim(entry.title);
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push(entry);
  }
  return groups;
};

const buildReport = (left, right, targetBookId) => {
  const leftGroups = groupByTitle(left), rightGroups = groupByTitle(right);
  const inventoriesComplete = left.coverage.completeSnapshotPresented && right.coverage.completeSnapshotPresented;
  const report = {
    kind: 'worldbook_entries', source: 'app_observed_content', readOnly: true,
    leftBookId: left.id, rightBookId: right.id, targetBookId: targetBookId || null,
    books: [bookRef(left), bookRef(right)], pairs: [], leftOnly: [], rightOnly: [],
    ambiguous: [], unverified: [], completeComparison: false,
  };
  for (const title of new Set([...leftGroups.keys(), ...rightGroups.keys()])) {
    const a = leftGroups.get(title) || [], b = rightGroups.get(title) || [];
    const refs = { title, left: a.map(entry => entryRef(left, entry)), right: b.map(entry => entryRef(right, entry)) };
    if (!title || a.length > 1 || b.length > 1) {
      report.ambiguous.push({ ...refs, reason: title ? 'duplicate_title' : 'missing_title' });
      continue;
    }
    if ([...a, ...b].some(entry => !fullEntry(entry))) {
      report.unverified.push({ ...refs, reason: 'content_incomplete' });
      continue;
    }
    if (a.length && b.length) {
      report.pairs.push({ title, matchBasis: 'unique_exact_title',
        relation: a[0].content === b[0].content ? 'same' : 'different',
        left: entryRef(left, a[0]), right: entryRef(right, b[0]),
      });
    } else if (!inventoriesComplete) {
      report.unverified.push({ ...refs, reason: 'opposite_inventory_incomplete' });
    } else {
      (a.length ? report.leftOnly : report.rightOnly).push(a.length ? refs.left[0] : refs.right[0]);
    }
  }
  report.completeComparison = Boolean(inventoriesComplete && !report.ambiguous.length && !report.unverified.length);
  return report;
};

const label = value => {
  const clean = trim(value).replace(/[\r\n]/gu, ' ');
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
};
const namedBook = book => label(book.name || book.id);
const messageBudget = value => Math.max(0, Math.min(2200, Math.trunc(Number(value)) || 0));
const formatReport = (report, maxMessageChars) => {
  const budget = messageBudget(maxMessageChars);
  const [left, right] = report.books;
  const different = report.pairs.filter(pair => pair.relation === 'different');
  const head = [
    t('APP 按已读原文整理；以下仅为方案，尚未执行合并或删除。'),
    t('左侧：{name}（ID：{id}）', { name: namedBook(left), id: label(left.id) }),
    t('右侧：{name}（ID：{id}）', { name: namedBook(right), id: label(right.id) }),
    t('已核对：{same} 组原文相同，{different} 组同名原文不同。', { same: report.pairs.length - different.length, different: different.length }),
    ...(!report.completeComparison ? [t('部分正文、条目对应关系或读取范围尚未核实，不能视为完整比较。')] : []),
  ].join('\n');
  const tail = [
    report.targetBookId
      ? t('已选方案目标：{id}；这不是写入授权。', { id: label(report.targetBookId) })
      : t('合并方向尚未选择，请确认哪一本作为目标。'),
    t('建议保留相同原文和双方独有内容；同名原文不同的条目请逐项选择左侧、右侧或两者。确认方案后仍须通过 APP 的写入确认，不会自动覆盖或删除任何一本。'),
  ].join('\n');
  const quote = (side, ref) => t('{side}原文：\n{content}', {
    side, content: ref.content,
  });
  const chunks = different.map(pair => [
    t('同名条目「{title}」的原文不同：', { title: label(pair.title) }),
    quote(t('左侧'), pair.left), quote(t('右侧'), pair.right),
  ].join('\n'));
  for (const [side, entries] of [[t('左侧'), report.leftOnly], [t('右侧'), report.rightOnly]]) {
    if (entries.length) chunks.push(t('仅在{side}完整读取中存在的 {count} 条：{titles}。建议保留，待确定目标后再确认是否追加。', {
      side, count: entries.length, titles: entries.map(entry => label(entry.title)).join('、'),
    }));
  }
  if (report.ambiguous.length) chunks.push(t('有 {count} 组重名或无标题条目，无法自动配对，请先明确对应关系。', { count: report.ambiguous.length }));
  if (report.unverified.length) chunks.push(t('有 {count} 组正文或对侧读取范围不完整，暂不判断是否独有或冲突。', { count: report.unverified.length }));
  const omission = t('部分原文或条目清单超过本次呈现预算，未完整显示；不能据此视为已呈现完整比较。');
  const selected = [], separator = '\n\n';
  for (const chunk of chunks) {
    if ([head, ...selected, chunk, omission, tail].join(separator).length <= budget) selected.push(chunk);
  }
  const omittedItems = chunks.length - selected.length;
  let message = [head, ...selected, ...(omittedItems ? [omission] : []), tail].join(separator);
  const summaryOmitted = message.length > budget;
  if (summaryOmitted) {
    message = [t('APP 按已读原文整理；以下仅为方案，尚未执行合并或删除。'), omission].join('\n');
    if (message.length > budget) message = '';
  }
  report.presentation = { complete: !omittedItems && !summaryOmitted && Boolean(message), omittedItems, summaryOmitted,
    maxMessageChars: budget, messageChars: message.length };
  return message;
};

export const resolveMaidWorldbookComparison = ({ input = '', steps = [], context = {}, comparison = null, maxMessageChars = 2200 } = {}) => {
  const available = buildMaidWorldbookComparisonContext({ input, steps, context });
  if (!available.eligible) return { ok: false, autoPresentEligible: false, status: 'not_applicable', reason: available.reason, message: '', report: null };
  const { autoPresentEligible } = available;
  const ledger = getLedger(steps, context), books = ledger.books;
  let left, right, targetBookId = '';
  if (comparison !== null && comparison !== undefined) {
    left = books.find(book => book.id === comparison.leftBookId);
    right = books.find(book => book.id === comparison.rightBookId);
    targetBookId = trim(comparison.targetBookId);
    if (comparison.kind !== 'worldbook_entries' || !left || !right || left.id === right.id
      || targetBookId && ![left.id, right.id].includes(targetBookId)) left = right = null;
  } else if (books.length === 2 && !ledger.omittedBooks) {
    // Stable identifiers order the display only. Names such as "copy" do not
    // select a merge source, destination, write target or permission.
    [left, right] = [...books].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  if (!left || !right) {
    const message = t('APP 已保留实际读取的世界书资料，请明确要比较的两本世界书；尚未选择合并目标，也未执行修改。');
    const budget = messageBudget(maxMessageChars);
    return {
    ok: true, autoPresentEligible, status: 'needs_selection', reason: 'comparison_books_not_selected',
    message: message.length <= budget ? message : '',
    report: { kind: 'worldbook_entries', source: 'app_observed_content', readOnly: true,
      books: available.books, omittedBooks: available.omittedBooks, completeComparison: false,
      presentation: { complete: message.length <= budget, maxMessageChars: budget, messageChars: message.length <= budget ? message.length : 0 } },
    };
  }
  const report = buildReport(left, right, targetBookId);
  const message = formatReport(report, maxMessageChars);
  const complete = report.completeComparison && report.presentation.complete;
  return { ok: true, autoPresentEligible, status: complete ? 'ready' : 'incomplete', reason: complete ? '' : 'comparison_evidence_incomplete', message, report,
    comparison: { kind: 'worldbook_entries', leftBookId: left.id, rightBookId: right.id, ...(targetBookId ? { targetBookId } : {}) },
  };
};
