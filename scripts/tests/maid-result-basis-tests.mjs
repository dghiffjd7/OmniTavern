import assert from 'node:assert/strict';
import { buildMaidResultBasis, normalizeMaidResultBasis } from '../../src/scripts/agent/maid-result-basis.js';
import { createMaidVoiceTaskRuntime } from '../../src/scripts/ui/maid-voice-task-runtime.js';
import { createMaidVoiceOrbUi, formatMaidVoiceResultBasis } from '../../src/scripts/ui/maid-voice-orb-ui.js';

const recordedAt = Date.UTC(2026, 8, 29, 8, 30, 12);
const result = { ok: true, status: 'responded', responseType: 'chat', source: 'maid_provider_fc', message: 'Here are the available methods.' };
const chat = buildMaidResultBasis(result, { recordedAt });
assert.equal(chat.kind, 'explanation');
assert.equal(chat.toolCount, 0);
assert.equal(chat.source, 'maid_provider_fc');
assert.equal(chat.recordedAt, recordedAt);
assert.equal('historyReused' in chat, false, 'a no-tool answer does not prove that history was reused');
assert.equal(buildMaidResultBasis({ plan: { toolName: 'web.search' }, runId: 'empty-run' }).kind, 'unverified');
console.log('ok - explanatory answers retain their origin without inventing execution or history reuse');

const research = {
  ok: true, responseType: 'react', steps: [
    { toolName: 'web.research', status: 'succeeded', output: { ok: true, sources: [
      { title: 'Official result', url: 'https://example.test/result', targetRelevant: true },
      { title: 'Duplicate', url: 'https://example.test/result' },
      { url: 'javascript:alert(1)' }, { url: 'file:///private' }, { url: 'https://user:password@example.test/' },
      { url: 'https://example.test/unrelated', targetRelevant: false },
    ], documents: [{ url: 'https://example.test/failed', ok: false }] } },
    { toolName: 'session.create', status: 'succeeded', output: { localToolExecutionSkipped: true } },
    { toolName: 'session.list', status: 'failed', output: { ok: false, reason: 'capability_validation_failed' } },
    { toolName: 'app.search_feature', status: 'succeeded', guided: true, output: { ok: true } },
  ],
};
const traceView = { runId: 'run-current', steps: [
  { id: 'actual-search', toolName: 'web.research', status: 'succeeded', startedAt: recordedAt - 500, finishedAt: recordedAt - 200 },
  { id: 'validation', toolName: 'session.list', status: 'failed' },
  { id: 'guided-tool', toolName: 'app.search_feature', status: 'succeeded' },
] };
const basis = buildMaidResultBasis(research, { traceView, recordedAt });
assert.equal(basis.kind, 'tool_execution');
assert.equal(basis.toolCount, 3);
assert.equal(basis.succeededToolCount, 2);
assert.equal(basis.tools[0].stepId, 'actual-search');
assert.equal(basis.tools[0].finishedAt, recordedAt - 200);
assert.equal(basis.tools[1].status, 'failed');
assert.deepEqual(basis.sources, [{ title: 'Official result', url: 'https://example.test/result', kind: 'search_result' }]);
assert.equal(buildMaidResultBasis({ responseType: 'react', steps: [research.steps[2]] }).kind, 'unverified');
assert.equal(buildMaidResultBasis({ responseType: 'react', steps: [research.steps[1]] }).succeededToolCount, 0);
assert.equal(buildMaidResultBasis({ responseType: 'chat' }, { traceView: { steps: [traceView.steps[1]] } }).kind, 'unverified');
console.log('ok - real observations and run timing exclude skipped work, failed validation and unsafe or unrelated sources');

const bounded = buildMaidResultBasis({ responseType: 'react', steps: Array.from({ length: 24 }, (_, i) => ({
  toolName: 'web.search', status: 'succeeded', args: { private: 'omitted' },
  output: { sources: [{ url: `https://example.test/${i}`, title: 'x'.repeat(1000), body: 'omitted' }] },
})) }, { recordedAt });
assert.equal(bounded.toolCount, 24); assert.equal(bounded.succeededToolCount, 24);
assert.equal(bounded.tools.length, 16); assert.equal(bounded.sources.length, 8);
assert.equal(bounded.sources[0].title.length, 160);
assert.equal(JSON.stringify(bounded).includes('omitted'), false);
assert.deepEqual(normalizeMaidResultBasis(bounded), bounded);
assert.equal(normalizeMaidResultBasis({ kind: 'tool_execution' }).kind, 'unverified');
assert.equal(normalizeMaidResultBasis({ recordedAt: Number.MAX_VALUE }).recordedAt, 0);
assert.equal(normalizeMaidResultBasis({ tools: [null, undefined, 1] }).toolCount, 0);
assert.equal(buildMaidResultBasis({ steps: [null, undefined] }, { traceView: { steps: [null] } }).toolCount, 0);
assert.equal(buildMaidResultBasis({ steps: [null, research.steps[0]] }, {
  traceView: { steps: [null, traceView.steps[0]] },
}).tools[0].stepId, 'actual-search');
assert.equal(normalizeMaidResultBasis({ sources: [{ url: 'https://example.test/old' }] }).sources[0].kind, 'unknown');
assert.equal(normalizeMaidResultBasis({ sources: [{ url: 'https://example.test/old', kind: 'claimed_citation' }] }).sources[0].kind, 'unknown');
console.log('ok - storage and protocol projection are bounded and omit arguments and observation bodies');

// Reduced shapes from the 12-step weather run: early research/search candidates
// precede five successful fetches whose URLs are top-level output fields.
const earlyHits = [
  { title: 'SpeechChat forum', url: 'https://obsproject.com/forum/tags/speechchatcom/' },
  { title: 'SpeechChat help', url: 'https://forum.speechchat.com/showthread.php?tid=385' },
  ...Array.from({ length: 3 }, (_, i) => ({ title: 'Early candidate', url: `https://example.test/early/${i}` })),
];
const cityHits = Array.from({ length: 5 }, (_, i) => ({ title: 'City candidate', url: `https://example.test/city/${i}` }));
const fetchedPages = [
  { url: 'https://www.cwa.gov.tw/V8/C/W/Town/Town.html?TID=6300100', title: 'Town forecast' },
  { url: 'https://www.cwa.gov.tw/V8/C/W/County/County.html?CID=63', title: 'County forecast' },
  { url: 'https://weather.com/zh-TW/weather/tenday/l/Taipei+Taiwan+TWXX0021:1:TW', title: 'Ten-day forecast' },
  { url: 'https://wttr.in/Taipei?lang=zh-tw', title: 'Weather report' },
  { url: 'https://api.open-meteo.com/v1/forecast?daily=temperature_2m_max', title: '' },
];
const searchStep = () => ({ toolName: 'web.search', status: 'succeeded', output: { ok: true, sources: cityHits, results: cityHits } });
const fetchStep = page => ({ toolName: 'web.fetch_url', status: 'succeeded', output: { ok: true, ...page } });
const weatherSteps = [
  { toolName: 'web.research', status: 'succeeded', output: { ok: true, evidenceStatus: 'target_not_checked',
    sources: earlyHits, results: earlyHits, documents: earlyHits.slice(0, 2).map(item => ({ ok: true, ...item })) } },
  searchStep(), searchStep(), fetchStep(fetchedPages[0]),
  searchStep(), searchStep(), searchStep(), searchStep(),
  ...fetchedPages.slice(1).map(fetchStep),
];
const weatherBasis = buildMaidResultBasis({ steps: weatherSteps }, { recordedAt });
assert.equal(weatherBasis.succeededToolCount, 12);
assert.equal(weatherBasis.sources.length, 8);
assert.deepEqual(weatherBasis.sources.slice(0, 5).map(source => source.url), fetchedPages.slice().reverse().map(page => page.url));
assert.ok(weatherBasis.sources.slice(0, 5).every(source => source.kind === 'fetched'));
assert.equal(weatherBasis.sources[0].title, 'api.open-meteo.com');
assert.deepEqual(weatherBasis.sources.slice(5, 7).map(source => source.kind), ['read_document', 'read_document']);
const sourceOrder = buildMaidResultBasis({ steps: [
  { toolName: 'web.search', status: 'succeeded', output: { sources: [{ ...cityHits[0], targetRelevant: true }] } },
  searchStep(), fetchStep(cityHits[0]),
  { toolName: 'web.fetch_url', status: 'failed', output: { ok: false, url: 'https://example.test/failed-fetch' } },
  { toolName: 'media.generate', status: 'succeeded', output: { ok: true, url: 'https://example.test/generated' } },
] });
assert.equal(sourceOrder.sources[0].kind, 'fetched', 'fetch metadata wins when the URL also appeared in search');
assert.equal(sourceOrder.sources[0].url, cityHits[0].url);
assert.equal(sourceOrder.sources.some(source => /failed-fetch|generated/.test(source.url)), false);
const relevantFirst = buildMaidResultBasis({ steps: [
  { toolName: 'web.search', status: 'succeeded', output: { sources: [{ url: 'https://example.test/relevant', targetRelevant: true }] } },
  searchStep(),
] });
assert.equal(relevantFirst.sources[0].url, 'https://example.test/relevant');
assert.equal(buildMaidResultBasis({ ok: true, status: 'succeeded', steps: [fetchStep(fetchedPages[0])] }).kind, 'tool_execution',
  'the actual single-step path has observations even without a ReAct responseType');
console.log('ok - late fetched pages survive early candidate overflow, with bounded access kinds and no reply-derived citations');

const tick = () => new Promise(resolve => setImmediate(resolve));
const queue = [], updates = [];
let sequence = 0, clock = recordedAt;
const tasks = createMaidVoiceTaskRuntime({
  now: () => clock, makeId: () => `task-${++sequence}`,
  getCommandRuntime: () => ({
    isSubmitting: () => queue.length > 0,
    submitVoiceTask: (request, options) => new Promise((resolve, reject) => queue.push({ request, options, resolve, reject })),
  }),
  onResult: update => updates.push(update),
});
const target = { maidCallId: 'call-current' };
const first = await tasks.request({ target, args: { action: 'execute', request: 'Explain the available methods.' } });
const second = await tasks.request({ target, args: { action: 'execute', request: 'Check the current result.' } });
assert.equal(first.resultBasis, undefined, 'acceptance is not a completed result');
tasks.updateTaskFromTrace({ ...traceView, submissionId: second.task_id, updatedAt: recordedAt - 100, status: 'running' });
queue[0].resolve(result); await tick();
clock += 1000; queue[1].resolve({ ...research, message: 'The search returned a source.' }); await tick();
assert.equal(updates[0].status, 'succeeded');
assert.equal(updates[0].message, result.message, 'basis never rewrites the backend answer');
assert.equal(updates[0].resultBasis.kind, 'explanation');
assert.equal(updates[0].resultBasis.runId, '', 'the other task cannot supply this answer with execution evidence');
assert.equal(updates[1].resultBasis.kind, 'tool_execution');
assert.equal(updates[1].resultBasis.runId, traceView.runId);
const status = await tasks.request({ target, args: { action: 'status' } });
assert.deepEqual(status.latest.resultBasis, updates[1].resultBasis);
status.latest.resultBasis.sources[0].title = 'changed outside';
assert.equal(tasks.getState().latest.resultBasis.sources[0].title, 'Official result');
tasks.updateTaskFromTrace({ submissionId: 'other-task', runId: 'foreign', steps: traceView.steps });
tasks.updateTaskFromTrace({ submissionId: second.task_id, runId: 'foreign', steps: traceView.steps });
assert.equal(tasks.getState().latest.resultBasis.runId, traceView.runId);
// A delayed partial trace cannot replace the complete result with "not recorded".
tasks.updateTaskFromTrace({ submissionId: second.task_id, runId: traceView.runId, updatedAt: recordedAt,
  steps: [{ id: 'actual-search', toolName: 'web.research', status: 'running', startedAt: recordedAt - 500 }] });
assert.equal(tasks.getState().latest.resultBasis.succeededToolCount, 2);
assert.equal(tasks.getState().latest.resultBasis.recordedAt, clock);
assert.deepEqual(tasks.getState().latest.resultBasis.sources, basis.sources);
console.log('ok - task completion, updates and status keep isolated evidence without changing success or messages');

const third = await tasks.request({ target, args: { action: 'execute', request: 'Another request.' } });
queue[2].reject(new Error('connection failed')); await tick();
assert.equal(tasks.getState().latest.task_id, third.task_id);
assert.equal(tasks.getState().latest.status, 'failed');
assert.equal(tasks.getState().latest.resultBasis.kind, 'unverified');
assert.equal(tasks.getState().latest.resultBasis.runId, '');
console.log('ok - failed submissions do not inherit an earlier task result');

const formatted = formatMaidVoiceResultBasis(basis);
assert.ok(formatted.startsWith('本次使用了工具 · '));
assert.ok(formatted.includes(new Date(recordedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })));
assert.ok(formatMaidVoiceResultBasis(chat).startsWith('本次未调用工具 · '));
assert.equal(formatMaidVoiceResultBasis({ kind: 'unverified' }), '依据未记录');
assert.equal(formatted.includes('web.research'), false);
assert.equal(formatted.includes('Official result'), false, 'the compact label does not claim a citation is verified');
assert.equal(formatMaidVoiceResultBasis(null), '');
const elements = [];
const element = () => {
  const el = { children: [], style: {}, dataset: {}, classList: { toggle() {} },
    appendChild(child) { this.children.push(child); }, setAttribute() {}, addEventListener() {}, querySelector() { return null; },
  };
  elements.push(el); return el;
};
const button = element(), modeSwitchEl = element();
modeSwitchEl.querySelector = () => button;
modeSwitchEl.getBoundingClientRect = () => ({ left: 10, top: 10, bottom: 40, width: 30 });
const orb = createMaidVoiceOrbUi({
  documentRef: { body: element(), head: element(), getElementById: () => null, createElement: element, addEventListener() {} },
  windowLike: { innerWidth: 400, innerHeight: 800, addEventListener() {} },
  modeSwitchEl, setTimeoutFn: () => 1, clearTimeoutFn() {},
});
orb.setTasks({ active: [], latest: updates[1], recent: [updates[1], updates[0]] });
const taskHtml = elements.find(el => el.className === 'maid-voice-orb-tasks').innerHTML;
assert.ok(taskHtml.includes('本次使用了工具'));
assert.ok(taskHtml.includes('本次未调用工具'));
assert.ok(taskHtml.includes('The search returned a source.'));
assert.equal(taskHtml.includes('web.research'), false);
assert.equal(taskHtml.includes('https://example.test/'), false);
console.log('ok - the real task tray renders result basis and time without changing the answer or exposing tool names');
