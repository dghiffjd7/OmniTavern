import assert from 'node:assert/strict';
import { createMaidRealtimeTools, neutralMaidAcceptedReceipt } from '../../src/scripts/ui/realtime/realtime-maid-tools.js';
import { getLocalizedPromptText, setPromptLocale } from '../../src/scripts/i18n/prompt-locale.js';
import { createMaidVoiceTaskRuntime } from '../../src/scripts/ui/maid-voice-task-runtime.js';

// Preserve the existing tool contract while narrowing the model-facing task rules.
const tools = createMaidRealtimeTools();
assert.equal(tools.length, 1);
assert.equal(tools[0].name, 'maid_task');
assert.deepEqual(Object.keys(tools[0].parameters.properties), ['action', 'request', 'task_id', 'scope']);
assert.deepEqual(tools[0].parameters.required, ['action']);
assert.deepEqual(tools[0].parameters.properties.action.enum, ['execute', 'status', 'cancel', 'revise', 'confirm']);
assert.match(tools[0].description, /same goal/);
assert.match(tools[0].description, /independent work, execute only the new request/);
assert.match(tools[0].description, /existing task or permission request must use revise/);
assert.match(tools[0].description, /New requests with read-only limits still use execute/);
assert.doesNotMatch(tools[0].description, /Any answer with conditions or exclusions/);
console.log('ok - one existing tool keeps its argument contract and scoped task guidance');

// A bounded receipt must not shorten the actual work, lose its final constraint,
// or reintroduce a spoken acknowledgement. No task is executed in this fixture.
const submissions = [];
const fullRequest = `${'仅查看当前页面的设置说明。'.repeat(20)}最后一条限制：不要修改任何设置。`;
const runtime = createMaidVoiceTaskRuntime({
  getCommandRuntime: () => ({
    isSubmitting: () => false,
    submitVoiceTask: (request, options) => {
      submissions.push({ request, options });
      return new Promise(() => {});
    },
  }),
  makeId: () => 'task-guidance-fixture',
});
const accepted = await runtime.request({
  target: { maidCallId: 'guidance-fixture-call' },
  args: { action: 'execute', request: fullRequest },
});
const receipt = neutralMaidAcceptedReceipt(accepted);
assert.equal(submissions[0].request, fullRequest);
assert.equal(accepted.request, fullRequest);
assert.equal(receipt.task_id, accepted.task_id);
assert.equal(receipt.request, fullRequest.slice(0, 160));
assert.equal(receipt.request_truncated, true);
assert.equal('message' in receipt, false);
assert.equal('confirmed' in receipt, false);
assert.deepEqual(neutralMaidAcceptedReceipt({ ok: true, accepted: true, request: '只看说明，别改设置。' }), {
  ok: true, accepted: true, request: '只看说明，别改设置。', request_truncated: false,
});
assert.deepEqual(neutralMaidAcceptedReceipt({ ok: true, accepted: true }), { ok: true, accepted: true });
console.log('ok - receipt identifies the task with a bounded summary while the full request remains intact');

// Read through the actual locale resolver to cover all shipped voice prompts.
for (const [locale, checks] of [
  ['zh-CN', [/同一未完成目标的条件/, /独立新增的工作用 execute/, /只查询、不要修改/, /一般点子直接回答/, /已有任务或授权问题/, /request 摘要只用于识别任务/]],
  ['zh-TW', [/同一未完成目標的條件/, /獨立新增的工作用 execute/, /只查詢、不要修改/, /一般點子直接回答/, /已有任務或授權問題/, /request 摘要只用於識別任務/]],
  ['en', [/same unfinished goal/, /independent new work/, /new request with read-only limits still uses execute/, /general ideas directly/, /existing task or permission question/, /request summary only identifies the task/]],
]) {
  setPromptLocale(locale);
  const prompt = getLocalizedPromptText('maid.voice.conversation');
  for (const pattern of checks) assert.match(prompt, pattern, `${locale}: ${pattern}`);
}
setPromptLocale('zh-CN');
console.log('ok - simplified Chinese, traditional Chinese and English retain the same task boundaries');
