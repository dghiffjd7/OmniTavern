// 同一任务里重复读世界书（Noa 的 fetch_page alreadyRead 与重复调用计数，按女仆的可见范围改写）：
// - 同一本书、同样的筛选、之间没有写入，且这次要读的正文已完整呈现在 <maid_worldbook_observations>
//   里时，不再返回正文，只回条目信息（reread 可坚持重读）；
// - 同样的读取（不计条数和长度参数）从第 2 次起在结果里注明是第几次，超过上限就不再执行；写入后重新计数。
import { buildMaidWorldbookObservationLedger, isMaidWorldbookObservationReset } from './maid-worldbook-observations.js';

const trim = value => String(value ?? '').trim();
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const outputOf = step => object(step?.output?.result) ? step.output.result : (object(step?.output) ? step.output : {});
const clamp = (value, fallback, min, max) => Math.max(min, Math.min(max, Number(value || fallback) || fallback));

export const MAID_WORLDBOOK_READ_REPEAT_LIMIT = 3;

// 与 worldbook.read 的实际取值一致（默认 50 条、每条 2000 字；有筛选时总是带正文）
const readShape = (args = {}) => {
  const entryId = trim(args.entryId), entryTitle = trim(args.entryTitle), query = trim(args.query);
  return {
    target: trim(args.worldbookId || args.id || args.name),
    sessionId: trim(args.sessionId),
    entryId, entryTitle, query,
    content: args.includeContent === true || Boolean(entryId || entryTitle || query),
    maxEntries: clamp(args.maxEntries, 50, 1, 200),
    maxContentLength: clamp(args.maxContentLength, 2000, 120, 12000),
  };
};

const sameFilter = (left, right) => ['entryId', 'entryTitle', 'query', 'content'].every(key => left[key] === right[key]);

// 指同一本书：按名称、ID 或上次读到的实际 ID 比对；都没指定时是同一会话的当前世界书
const sameBook = (shape, step) => {
  const earlier = readShape(step.args), out = outputOf(step);
  if (!shape.target || !earlier.target) return !shape.target && !earlier.target && shape.sessionId === earlier.sessionId;
  return [earlier.target, trim(out.id), trim(out.name), trim(out.worldbookId)].includes(shape.target);
};

const isAppVerification = plan => Boolean(trim(plan?.metadata?.verificationFor) || trim(plan?.metadata?.crossRunArgsDigest));

const contentLimitReached = (entry, earlier, shape) => entry.contentTruncated === true && shape.maxContentLength > earlier.maxContentLength;

// 这次读取会返回的每条正文，是否都已至少同样长地呈现在已读记录里（不算上一轮带来的）
const visibleInLedger = ({ out, entries, shape, steps, context, carried }) => {
  if (!entries.length) return true;
  const ids = entries.map(entry => trim(entry?.id));
  if (ids.some((id, index) => !id || ids.indexOf(id) !== index)) return false;
  const book = buildMaidWorldbookObservationLedger({ steps, context, carried })?.books.find(item => item.id === trim(out.id));
  if (!book) return false;
  return entries.every((entry) => {
    if (entry.contentSource === 'promptBlocks' || entry.requiresPromptBlockId) return false;
    const shown = book.entries.find(item => item.id === trim(entry.id) && !item.earlierRun);
    const full = Number.isInteger(entry.contentLength) ? entry.contentLength : Infinity;
    return typeof shown?.content === 'string' && shown.content.length >= Math.min(shape.maxContentLength, full);
  });
};

/** 执行 worldbook.read 之前：同样的读取已做过几次，以及能否直接回「已读过」。 */
export const inspectMaidWorldbookRead = ({ plan = {}, steps = [], context = {}, carried = null } = {}) => {
  if (trim(plan?.toolName) !== 'worldbook.read' || isAppVerification(plan)) return null;
  const args = object(plan.args) ? plan.args : {};
  const shape = readShape(args);
  const list = Array.isArray(steps) ? steps : [];
  let earlier = [];
  for (const step of list) {
    if (isMaidWorldbookObservationReset(step)) { earlier = []; continue; }
    if (step?.toolName !== 'worldbook.read' || step.status !== 'succeeded' || outputOf(step).ok === false) continue;
    if (sameFilter(shape, readShape(step.args)) && sameBook(shape, step)) earlier.push(step);
  }
  if (!earlier.length) return null;
  const count = earlier.length + 1;
  const lastStep = Number(earlier.at(-1).index) || 0;
  if (count > MAID_WORLDBOOK_READ_REPEAT_LIMIT) return { count, lastStep, blocked: true };
  const source = earlier.findLast(step => outputOf(step).alreadyRead !== true);
  if (!source || trim(args.reread)) return { count, lastStep };
  const out = outputOf(source), previous = readShape(source.args);
  if (!Array.isArray(out.entries) || !trim(out.id)) return { count, lastStep };
  // 上次被条数或长度上限截断、这次要得更多：是在补读，照常执行
  if (out.truncated === true && shape.maxEntries > previous.maxEntries) return { count, lastStep };
  const entries = out.entries.slice(0, shape.maxEntries).filter(object);
  if (entries.length && (!shape.content || out.contentMode !== 'content')) return { count, lastStep };
  if (entries.some(entry => contentLimitReached(entry, previous, shape))) return { count, lastStep };
  if (!visibleInLedger({ out, entries, shape, steps: list, context, carried })) return { count, lastStep };
  return { count, lastStep, alreadyRead: { step: Number(source.index) || 0, out, entries } };
};

const withoutBodies = ({ content, contentTruncated, promptBlocks, ...entry }) => ({
  ...entry,
  ...(Array.isArray(promptBlocks) ? { promptBlocks: promptBlocks.map(({ content: body, contentTruncated: cut, ...block }) => block) } : {}),
});

export const buildMaidWorldbookAlreadyReadExecution = ({ alreadyRead }) => {
  const { step, out, entries } = alreadyRead;
  const message = entries.length
    ? `同样的读取在第 ${step} 步做过，之后没有写入；这 ${entries.length} 条正文在 <maid_worldbook_observations> 里已有这次读取会返回的全部内容，这里只回条目信息。确实需要重读时（例如书可能在别处被改过），传 reread 写明原因。`
    : `同样的读取在第 ${step} 步做过：没有匹配的条目，之后也没有写入。确实需要重读时，传 reread 写明原因。`;
  return {
    output: {
      toolName: 'worldbook.read',
      status: 'succeeded',
      summary: `worldbook read skipped: same read at step ${step} is still in view`,
      // 不带 id：已读记录和其它按读取结果取证的逻辑都不会把这一步当成新的读取
      result: {
        ok: true,
        alreadyRead: true,
        localToolExecutionSkipped: true,
        worldbookId: trim(out.id),
        name: trim(out.name),
        readStep: step,
        entryCount: out.entryCount,
        returnedEntryCount: entries.length,
        entries: entries.map(withoutBodies),
        message,
      },
    },
    guided: false,
    guide: null,
    message: '',
  };
};

export const buildMaidWorldbookReadBlockedExecution = ({ count, lastStep }) => ({
  output: {
    toolName: 'worldbook.read',
    status: 'failed',
    summary: 'worldbook read blocked: same read repeated without a write in between',
    errorCode: 'maid_worldbook_read_repeated',
    result: {
      ok: false,
      reason: 'worldbook_read_repeated',
      readCount: count - 1,
      lastReadStep: lastStep,
      message: `同一本书同样的筛选（不计条数和长度参数）在本次任务里已经读了 ${count - 1} 次（最近在第 ${lastStep} 步），之间没有写入，相同的读取不会再执行。`,
    },
  },
  guided: false,
  guide: null,
  message: '',
});

/** 照常执行的重复读取：在结果里注明是第几次。 */
export const noteMaidWorldbookRepeatedRead = (execution, { count, lastStep }) => {
  const output = execution && Object.hasOwn(execution, 'output') ? execution.output : execution;
  const result = object(output?.result) ? output.result : null;
  if (!result || result.ok === false) return execution;
  const noted = {
    ...output,
    result: {
      ...result,
      repeatedRead: {
        count,
        lastReadStep: lastStep,
        note: `同一本书同样的筛选（不计条数和长度参数），这是本次任务第 ${count} 次读取（上次在第 ${lastStep} 步），之间没有写入。`,
      },
    },
  };
  return execution && Object.hasOwn(execution, 'output') ? { ...execution, output: noted } : noted;
};
