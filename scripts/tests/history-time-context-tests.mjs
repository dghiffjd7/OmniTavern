import assert from 'node:assert/strict';
import {
  HISTORY_TIMESTAMP_FIELD as field,
  createHistoryTimeFormatter,
  isHistoryTimeContextEnabled,
  projectHistoryTimeMessages,
  resolveHistoryTimestamp,
} from '../../src/scripts/ui/chat/history-time-context-utils.js';
import { buildLlmHistoryForSession } from '../../src/scripts/ui/chat/llm-history-builder-utils.js';
import { limitHistoryByTokenBudget } from '../../src/scripts/ui/chat/llm-history-utils.js';
import { estimateTokens } from '../../src/scripts/memory/memory-prompt-utils.js';

const at = (day, hour = 9, year = 2026) => new Date(year, 8, day, hour).getTime();
const item = (content, timestamp, role = 'user') => ({ role, content, [field]: timestamp });
const project = messages => projectHistoryTimeMessages(messages, { enabled: true });
const used = messages => messages.reduce((sum, message) => sum + estimateTokens(message.content, 'strict'), 0);

assert.equal(isHistoryTimeContextEnabled({}, {}), false);
assert.equal(isHistoryTimeContextEnabled({}, { promptCurrentTimeEnabled: true }), true);
assert.equal(isHistoryTimeContextEnabled({ meta: { includeTimeContext: false } }, { promptCurrentTimeEnabled: true }), false);
assert.equal(isHistoryTimeContextEnabled({ meta: { includeTimeContext: true } }, {}), true);
for (const context of [{ meta: { uiMode: 'rp' } }, { session: { id: 'rp:one' } }, { task: { type: 'moment_comment' } }]) {
  assert.equal(isHistoryTimeContextEnabled(context, { promptCurrentTimeEnabled: true }), false);
}
assert.equal(resolveHistoryTimestamp({ time: '09:15', timestamp: 'invalid' }), 0);
assert.equal(resolveHistoryTimestamp({ timestamp: 9e18 }), 0);

const source = [item('旧年的消息', at(15, 9, 2025)), item('早上好', at(15)), item('你好', at(15, 10), 'assistant'),
  { role: 'system', content: '中间的提示词' }, item('下午再聊', at(15, 12)), item('跨日了', at(16, 1), 'assistant'),
  item('傍晚', at(16, 18)), item('无日期', 0), item('仍无日期', 0, 'assistant'), item('又有日期', at(16, 19))];
const original = structuredClone(source);
const projected = project(source);
assert.equal(projected.length, source.length);
assert.deepEqual(projected.map(message => message.role), source.map(message => message.role));
assert.match(projected[0].content, /^\[2025-09-15 上午\]\n/);
assert.match(projected[1].content, /^\[2026-09-15 上午\]\n/);
assert.equal(projected[2].content, '你好');
assert.equal(projected[3].content, '中间的提示词');
assert.match(projected[4].content, /^\[2026-09-15 下午\]\n/);
assert.match(projected[5].content, /^\[2026-09-16 凌晨\]\n/);
assert.match(projected[6].content, /^\[2026-09-16 晚上\]\n/);
assert.equal(projected[7].content, '[日期未知]\n无日期');
assert.equal(projected[8].content, '仍无日期');
assert.match(projected[9].content, /^\[2026-09-16 晚上\]\n/);
assert.ok(projected.every(message => !(field in message)));
assert.deepEqual(source, original, 'projection must not modify saved/assembled history');
assert.deepEqual(projectHistoryTimeMessages(source).map(message => message.content), source.map(message => message.content));

const image = { type: 'image_url', image_url: { url: 'fixture://image' } };
const media = project([item([image], at(20)), item([{ type: 'text', text: '附件说明' }, image], at(20, 15))]);
assert.deepEqual(media[0].content, [{ type: 'text', text: '[2026-09-20 上午]' }, image]);
assert.deepEqual(media[1].content, [{ type: 'text', text: '[2026-09-20 下午]\n附件说明' }, image]);

const stored = [{ id: 'one', role: 'user', content: '原文一', timestamp: at(15), time: '23:59' },
  { id: 'two', role: 'assistant', content: '原文二', timestamp: at(15, 10), meta: { chatTime: { modelTime: '03:00' } } },
  { id: 'pending', role: 'user', content: '待发送', timestamp: at(20), status: 'pending' }];
const history = buildLlmHistoryForSession({ messages: stored, settings: { chatHistoryMax: 1 } });
assert.equal(history.length, 1);
assert.equal(history[0][field], at(15, 10));
assert.equal(history[0].content, '原文二');
assert.match(project(history)[0].content, /^\[2026-09-15 上午\]\n/);
assert.ok(buildLlmHistoryForSession({ messages: stored, rpUiMode: true }).every(message => !(field in message)));

const formatter = createHistoryTimeFormatter();
const limit = (messages, options) => limitHistoryByTokenBudget(messages, {
  tokenMode: 'strict', getMessagePrefix: formatter.prefixFor, ...options,
});
const sameDay = [item('一'.repeat(20), at(15)), item('二'.repeat(20), at(15, 10)), item('三'.repeat(20), at(15, 11))];
const quota = used(project(sameDay.slice(1)));
const clipped = limit(sameDay, { inputBudgetTokens: quota });
assert.deepEqual(clipped.stats.keptOriginalIndexes, [1, 2]);
assert.equal(clipped.stats.usedTokens, used(project(clipped.messages)));
assert.match(project(clipped.messages)[0].content, /^\[2026-09-15 上午\]/);

const split = [item('aa', at(15)), item('bbb', at(16)), item('cc', at(15))];
const protectedQuota = used(project([split[0], split[2]]));
const protectedResult = limit(split, { inputBudgetTokens: protectedQuota, protectedMessageIndexes: [0, 2] });
assert.deepEqual(protectedResult.stats.keptOriginalIndexes, [0, 2]);
assert.equal(protectedResult.stats.usedTokens, protectedQuota, 'removing an intervening day merges the adjacent segments');
assert.equal(project(protectedResult.messages)[1].content, 'cc');
for (const budget of [0, 2, 24, 80]) {
  // Explicit user budget 0 means unbounded in the existing budget API. A
  // context fully reserved for output/safety represents an actual zero quota.
  const result = limit([item('内容'.repeat(200), at(20))], budget === 0
    ? { maxContext: 512, reserveTokens: 512 }
    : { inputBudgetTokens: budget });
  assert.ok(result.stats.usedTokens <= budget);
  assert.equal(result.stats.usedTokens, used(project(result.messages)));
}
const hundred = Array.from({ length: 100 }, (_, index) => item(`消息${index}`, at(15 + Math.floor(index / 20), index % 20 < 10 ? 9 : 15)));
assert.equal(project(hundred).filter(message => /^\[2026-/.test(message.content)).length, 10);
console.log('history-time-context-tests passed: scope, periods, unknown dates, attachments, source preservation, filtering and budget boundaries');
