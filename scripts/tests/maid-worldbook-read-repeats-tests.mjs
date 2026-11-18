import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaidAssistantAgent } from '../../src/scripts/agent/maid-assistant-agent.js';
import { createAgentTaskRuntime } from '../../src/scripts/agent/agent-task-runtime.js';
import { AgentRunStore } from '../../src/scripts/storage/agent-run-store.js';
import { buildMaidModelReActMessages } from '../../src/scripts/agent/maid-model-planner.js';
import { buildMaidRunContinuationPromptBlock } from '../../src/scripts/agent/maid-run-continuation.js';
import { buildMaidWorldbookObservationLedger, normalizeCarriedMaidWorldbookObservations } from '../../src/scripts/agent/maid-worldbook-observations.js';
import { inspectMaidWorldbookRead, MAID_WORLDBOOK_READ_REPEAT_LIMIT } from '../../src/scripts/agent/maid-worldbook-read-repeats.js';

// 读取结果的形状与 worldbook.read 一致（11/14 那几轮读「苏晓彤」的缩小版）
const entry = (id, content, extra = {}) => ({ id, title: `title:${id}`, keys: [id], disabled: false, contentLength: content.length,
  content, contentTruncated: false, contentSource: 'content', promptBlocks: [], ...extra });
const readStep = (index, args, entries, { total = entries.length, truncated = false, mode = 'content' } = {}) => ({
  index, toolName: 'worldbook.read', status: 'succeeded', args,
  output: { ok: true, id: 'wb', name: '苏晓彤', entryCount: total, contentMode: mode, returnedEntryCount: entries.length, truncated,
    entries: mode === 'content' ? entries : entries.map(({ content, contentTruncated, ...rest }) => rest) },
});
const plan = args => ({ toolName: 'worldbook.read', args });
const write = index => ({ index, toolName: 'worldbook.update_entries', status: 'succeeded', args: { name: '苏晓彤' }, output: { ok: true, worldbookSaved: true } });

test('a repeated read whose bodies are still fully in view returns only entry info', () => {
  const steps = [readStep(1, { name: '苏晓彤', query: '林' }, [entry('lin', '林'.repeat(300))])];
  // 只改显示参数、按 ID 指同一本书：仍是同样的读取
  const seen = inspectMaidWorldbookRead({ plan: plan({ worldbookId: 'wb', query: '林', maxEntries: 5 }), steps });
  assert.equal(seen.count, 2);
  assert.equal(seen.alreadyRead.step, 1);
  assert.deepEqual(seen.alreadyRead.entries.map(item => item.id), ['lin']);
  assert.equal(inspectMaidWorldbookRead({ plan: plan({ name: '苏晓彤', query: '林', reread: '书可能在外面被改过' }), steps }).alreadyRead, undefined, 'reread 坚持重读');
  assert.equal(inspectMaidWorldbookRead({ plan: plan({ name: '苏晓彤', query: '苏' }), steps }), null, '不同筛选不算重复');
  assert.equal(inspectMaidWorldbookRead({ plan: { ...plan({ name: '苏晓彤', query: '林' }), metadata: { verificationFor: 'worldbook.update_entries' } }, steps }), null, 'APP 写后读回不拦');
});

test('a query that found nothing is not searched again unchanged', () => {
  const steps = [readStep(1, { name: '苏晓彤', query: '鸠' }, [], { total: 40 })];
  const seen = inspectMaidWorldbookRead({ plan: plan({ name: '苏晓彤', query: '鸠', maxEntries: 5, maxContentLength: 4000 }), steps });
  assert.equal(seen.alreadyRead.entries.length, 0);
});

test('reads that would show more than she can see now still run, with the repeat noted', () => {
  // 40 条的书：已读记录 8000 字放不下每条全文，重读是为了真正看到正文，不能回「已读过」
  const big = Array.from({ length: 40 }, (_, i) => entry(`e${i}`, `正文${i}`.repeat(200)));
  let seen = inspectMaidWorldbookRead({ plan: plan({ name: '苏晓彤', includeContent: true }), steps: [readStep(1, { name: '苏晓彤', includeContent: true }, big)] });
  assert.deepEqual([seen.count, seen.alreadyRead], [2, undefined]);
  // 上次被长度上限截断、这次要更长：是补读
  const cut = [readStep(1, { name: '苏晓彤', query: '林', maxContentLength: 120 }, [entry('lin', '林'.repeat(120), { contentLength: 900, contentTruncated: true })])];
  seen = inspectMaidWorldbookRead({ plan: plan({ name: '苏晓彤', query: '林', maxContentLength: 4000 }), steps: cut });
  assert.equal(seen.alreadyRead, undefined);
  // 条目目录（不带正文）不在已读记录里，照常执行
  const index = [readStep(1, { name: '苏晓彤' }, [entry('lin', '林')], { mode: 'summary' })];
  assert.equal(inspectMaidWorldbookRead({ plan: plan({ name: '苏晓彤', maxEntries: 100 }), steps: index }).alreadyRead, undefined);
});

test('the same read is blocked past the limit and counting restarts after a write', () => {
  const same = i => readStep(i, { name: '苏晓彤', maxEntries: 40 + i }, [entry('lin', '林')], { mode: 'summary' });
  const steps = Array.from({ length: MAID_WORLDBOOK_READ_REPEAT_LIMIT }, (_, i) => same(i + 1));
  assert.deepEqual(inspectMaidWorldbookRead({ plan: plan({ name: '苏晓彤' }), steps }), { count: 4, lastStep: 3, blocked: true });
  assert.equal(inspectMaidWorldbookRead({ plan: plan({ name: '苏晓彤' }), steps: [...steps, write(4)] }), null);
  assert.equal(inspectMaidWorldbookRead({ plan: plan({ name: '苏晓彤' }), steps: [...steps, write(4), same(5)] }).count, 2);
});

test('the read ledger carried into a continuation keeps what is still valid', () => {
  const steps = [readStep(1, { name: '苏晓彤', includeContent: true }, [entry('lin', '林'.repeat(30)), entry('su', '苏'.repeat(30), { disabled: true })])];
  const carried = normalizeCarriedMaidWorldbookObservations(buildMaidWorldbookObservationLedger({ steps }));
  assert.ok(carried.books[0].entries.every(item => item.earlierRun === true && !('observedStep' in item)));
  let book = buildMaidWorldbookObservationLedger({ steps: [], carried }).books[0];
  assert.deepEqual(book.entries.map(item => [item.id, item.content.length, item.disabled === true]), [['lin', 30, false], ['su', 30, true]]);
  // 本轮读目录：长度变了的正文丢弃，启用状态在别处改了只更新标记
  const index = readStep(1, { name: '苏晓彤' }, [entry('lin', '林'.repeat(31)), entry('su', '苏'.repeat(30))], { mode: 'summary' });
  book = buildMaidWorldbookObservationLedger({ steps: [index], carried }).books[0];
  assert.deepEqual(book.entries.map(item => [item.id, item.disabled === true]), [['su', false]]);
  assert.equal(buildMaidWorldbookObservationLedger({ steps: [write(1)], carried }), null, '本轮写入后旧记录作废');
  const owned = { books: carried.books.map(item => ({ ...item, ownership: { currentCard: { personaId: 'other-card' } } })) };
  assert.equal(buildMaidWorldbookObservationLedger({ steps: [], context: { roleCardId: 'card' }, carried: owned }), null, '别的角色卡的记录不带');
  // 进提示词时并入已读记录并说明来源，续跑账本里不重复
  const continuation = { sourceRunId: 'run:1', goal: '扩写', worldbookObservations: carried };
  const user = buildMaidModelReActMessages({ input: '继续', features: [], steps: [], transportMode: 'provider_fc', context: { runContinuation: continuation } })[1].content;
  assert.match(user, /Entries marked earlierRun[\s\S]*<maid_worldbook_observations>[\s\S]*"earlierRun":true/);
  assert.doesNotMatch(buildMaidRunContinuationPromptBlock(continuation), /worldbookObservations|林林林/);
});

test('in a run: duplicate reads skip the tool, and saying 继续喵 resumes with the read ledger', async () => {
  const book = [entry('lin', '林'.repeat(40)), entry('su', '苏'.repeat(40))];
  const calls = [];
  const registry = {
    get: name => ({ name, capabilities: { write: name !== 'worldbook.read' } }),
    executeTool: async (name, args) => {
      calls.push(args);
      const query = String(args.query || '');
      const entries = book.filter(item => !query || item.content.includes(query));
      return { toolName: name, status: 'succeeded', summary: `read worldbook 苏晓彤 (${entries.length} entries)`,
        result: readStep(0, args, entries, { total: book.length }).output };
    },
  };
  const store = new AgentRunStore({ storage: null });
  const logger = { debug() {}, warn() {} };
  const runtime = createAgentTaskRuntime({ store, toolRegistry: registry, logger });
  const scope = { roleCardId: 'card', sessionId: '', uiMode: 'chat' };
  const decisions = [
    { ok: true, action: 'tool', toolName: 'worldbook.read', featureId: 'worldbook.read', args: { name: '苏晓彤', includeContent: true, maxEntries: 10 } },
    { ok: true, action: 'tool', toolName: 'worldbook.read', featureId: 'worldbook.read', args: { name: '苏晓彤', query: '鸠' } },
    { ok: true, action: 'tool', toolName: 'worldbook.read', featureId: 'worldbook.read', args: { name: '苏晓彤', query: '鸠', maxEntries: 3 } },
    { ok: true, action: 'tool', toolName: 'worldbook.read', featureId: 'worldbook.read', args: { name: '苏晓彤', maxEntries: 50 } },
    { ok: true, action: 'tool', toolName: 'worldbook.read', featureId: 'worldbook.read', args: { name: '苏晓彤', maxEntries: 80 } },
    { ok: false, reason: 'provider_request_failed', message: '女仆暂时无法继续判断下一步。', errorMessage: 'No candidates returned: PROHIBITED_CONTENT' },
  ];
  let received = null;
  const agent = createMaidAssistantAgent({ agentTaskRuntime: runtime, toolRegistry: registry, logger,
    planner: async (_input, context) => {
      if (context?.runContinuation) { received = context; return { ok: true, action: 'final', message: '接着做' }; }
      return { ok: true, action: 'tool', toolName: 'worldbook.read', featureId: 'worldbook.read', args: { name: '苏晓彤', includeContent: true } };
    },
    reactPlanner: async () => decisions.shift(),
  });
  const first = await agent.runPrompt('把她们扩写一下', scope);
  assert.equal(first.continuable, true);
  assert.equal(calls.length, 4, '只改显示参数的重读、没变的空搜索都没有再调用工具');
  const [, again, search, emptyAgain, index, indexAgain] = first.steps;
  assert.equal(index.output.repeatedRead, undefined);
  assert.deepEqual([indexAgain.output.repeatedRead.count, indexAgain.output.repeatedRead.lastReadStep], [2, 5], '目录不在已读记录里，照常读，注明第几次');
  assert.match(indexAgain.output.repeatedRead.note, /第 2 次读取/);
  assert.equal(again.output.alreadyRead, true);
  assert.ok(again.output.entries.every(item => !('content' in item)), '只回条目信息');
  assert.equal(search.output.repeatedRead, undefined);
  assert.equal(emptyAgain.output.alreadyRead, true);
  assert.equal(emptyAgain.output.returnedEntryCount, 0);
  const source = store.listRuns().find(run => run.metadata?.continuable);
  const carried = source.metadata.continuationSnapshot.worldbookObservations;
  assert.deepEqual(carried.books[0].entries.map(item => [item.id, item.content, item.earlierRun]), book.map(item => [item.id, item.content, true]));

  await agent.runPrompt('继续喵', scope);
  assert.equal(received?.runContinuation?.sourceRunId, source.id, '「继续喵」接上了中断的任务');
  assert.deepEqual(received.runContinuation.worldbookObservations, carried);
});
