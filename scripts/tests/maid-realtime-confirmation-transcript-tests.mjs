import assert from 'node:assert/strict';
import { createRealtimeMaidTaskSession } from '../../src/scripts/ui/realtime/realtime-maid-task-session.js';
import { createMaidVoiceTaskRuntime } from '../../src/scripts/ui/maid-voice-task-runtime.js';
import { createGeminiLiveProtocol } from '../../src/scripts/ui/realtime/realtime-gemini-protocol.js';
import { createNovaSonicProtocol } from '../../src/scripts/ui/realtime/realtime-nova-protocol.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const exercise = async (outcome, native = null) => {
  const approvals = [], submissions = [], receipts = [], evidence = [], taskUpdates = [], timers = new Map();
  let taskId, sequence = 0, timerId = 0;
  const target = { uiMode: 'maid', sessionId: 'maid', maidCallId: 'permission-fixture' };
  const voice = createMaidVoiceTaskRuntime({ makeId: () => `task-${++sequence}`,
    getApproval: id => id === taskId ? { id: 'permission' } : null,
    confirmApproval: ids => { approvals.push(...ids); return true; },
    getCommandRuntime: () => ({
      submitVoiceTask: (text, options) => new Promise(resolve => submissions.push({ text, options, resolve })),
      cancelSubmission: id => { const entry = submissions.find(s => s.options.id === id); if (!entry) return false; entry.resolve({ cancelled: true }); return true; },
    }),
  });
  taskId = (await voice.request({ target, args: { action: 'execute', request: '删除第一项和第二项' } })).task_id;
  let protocol;
  const session = createRealtimeMaidTaskSession({ target, provider: native?.provider || 'step_realtime',
    setTimeoutFn: fn => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeoutFn: id => timers.delete(id),
    getClient: () => ({ sendToolResults: results => { receipts.push(...results); protocol?.toolResults(results); }, requestResponse() {},
      sendTaskUpdate: text => { taskUpdates.push(text); protocol?.taskUpdate(text); } }),
    handleTaskRequest: options => { evidence.push(options); return voice.request(options); },
  });
  const transcript = (text, item_id = 'permission-answer') => session.handle({ type: 'conversation.item.input_audio_transcription.completed', item_id, transcript: text });
  try {
    if (native) {
      const options = { profile: { provider: native.provider, model: 'fixture' }, instructions: '', send() {},
        emit: event => session.handle(event), ready() {}, play() {}, clear() {} };
      protocol = native.provider === 'gemini_live' ? createGeminiLiveProtocol(options) : createNovaSonicProtocol(options);
      const conditional = '允许，但不要删除第二项';
      const call = { id: 'native-confirm', name: 'maid_task', args: { action: 'confirm', request: '允许' } };
      const novaUser = (responseId, itemId, text) => {
        protocol.receive({ event: { contentStart: { completionId: responseId, contentId: itemId, role: 'USER', type: 'TEXT', additionalModelFields: '{"generationStage":"FINAL"}' } } });
        protocol.receive({ event: { textOutput: { contentId: itemId, content: text } } });
        protocol.receive({ event: { contentEnd: { contentId: itemId } } });
      };
      if (native.provider === 'gemini_live') {
        protocol.receive({ serverContent: { inputTranscription: { text: '允许' }, turnComplete: true } });
        if (native.preface) protocol.receive({ serverContent: { outputTranscription: { text: '好的' } } });
        protocol.receive({ toolCall: { functionCalls: [call] } });
      } else {
        protocol.receive({ event: { completionStart: { completionId: 'previous-response' } } });
        novaUser('previous-response', 'previous-input', '允许');
        protocol.receive({ event: { completionEnd: { completionId: 'previous-response' } } });
        protocol.receive({ event: { completionStart: { completionId: 'native-response' } } });
        protocol.receive({ event: { contentStart: { completionId: 'native-response', contentId: 'native-tool', role: 'TOOL', type: 'TOOL' } } });
        protocol.receive({ event: { toolUse: { contentId: 'native-tool', toolUseId: call.id, toolName: call.name, content: JSON.stringify(call.args) } } });
        protocol.receive({ event: { contentEnd: { contentId: 'native-tool', stopReason: 'TOOL_USE' } } });
      }
      await tick();
      const approvalsBeforeCurrentAsr = approvals.length, executionsBeforeCurrentAsr = evidence.length;
      if (native.provider === 'gemini_live') protocol.receive({ serverContent: { inputTranscription: { text: conditional }, turnComplete: true } });
      else {
        novaUser('native-response', 'native-input', conditional);
        protocol.receive({ event: { completionEnd: { completionId: 'native-response' } } });
      }
      await tick();
      assert.equal(approvalsBeforeCurrentAsr, 0, 'a native response without speech_started cannot borrow the previous completed permission');
      assert.equal(executionsBeforeCurrentAsr, 0, 'confirmation waits for its own final input');
      assert.equal(approvals.length, 0);
      assert.equal(evidence.length, 1, 'late input associated with this response wakes the pending confirmation');
      assert.equal(evidence[0].inputText, conditional);
      assert.equal(submissions.length, 2, 'late conditional permission revises the original task');
      assert.match(submissions[1].text, /不要删除第二项/);
      assert.equal(timers.size, 0, 'response-linked late input releases the original waiter');
      return;
    }
    session.handle({ type: 'input_audio_buffer.speech_started', item_id: 'permission-answer' });
    session.handle({ type: 'input_audio_buffer.speech_stopped', item_id: 'permission-answer' });
    session.handle({ type: 'response.created', response: { id: 'permission-response' } });
    const call = { id: 'confirmation-call', name: 'maid_task', arguments: '{"action":"confirm","request":"允许"}' };
    session.handle({ type: 'maid.tools.requested', response_id: 'permission-response', calls: [call] });
    await tick();
    assert.equal(approvals.length, 0, 'service completion cannot grant permission before final user transcription');
    assert.equal(evidence.length, 0);
    if (outcome === 'conditional') transcript('允许，但不要删除第二项');
    if (outcome === 'allow') transcript('允许');
    if (outcome === 'empty') transcript('');
    if (outcome === 'failed') session.handle({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'permission-answer' });
    if (outcome === 'closed') { session.dispose(); transcript('允许'); }
    if (outcome === 'cancelled') {
      session.handle({ type: 'response.cancelled', response: { id: 'permission-response', status: 'cancelled' } });
      session.notifyTaskUpdate({ target, task_id: 'other-task', status: 'succeeded', message: 'Another task has finished' });
      assert.equal(taskUpdates.length, 0, 'the input waiter currently blocks result delivery');
      session.handle({ type: 'maid.tools.cancelled', ids: [call.id] });
      await tick();
      assert.equal(timers.size, 0, 'tool cancellation releases its waiter without any later transcription');
      assert.equal(taskUpdates.length, 1, 'cancelling the input waiter unblocks an independent actual task result');
    }
    if (outcome === 'unrelated_then_timeout') {
      transcript('允许', 'unrelated-input'); await tick();
      assert.equal(approvals.length, 0, 'another input cannot satisfy the original confirmation');
      for (const expire of [...timers.values()]) expire();
    }
    await tick();
    assert.equal(approvals.length, outcome === 'allow' ? 1 : 0);
    if (outcome === 'conditional') {
      assert.equal(evidence[0].inputText, '允许，但不要删除第二项');
      assert.match(submissions.at(-1).text, /不要删除第二项/);
      assert.equal(submissions.length, 2, 'conditional permission revises instead of granting old permission');
    }
    if (['empty', 'failed', 'unrelated_then_timeout'].includes(outcome)) {
      assert.equal(evidence.length, 0);
      assert.equal(receipts[0].result.ok, false);
      assert.equal(receipts[0].result.reason, 'confirmation_transcript_unavailable');
    }
    if (['closed', 'cancelled'].includes(outcome)) assert.equal(receipts.length, 0);
    assert.equal(timers.size, 0, 'final transcript, cancellation settlement and disposal release the input waiter');
  } finally { session.dispose(); submissions.forEach(s => s.resolve({ cancelled: true })); }
};
const failures = [];
const cases = process.argv.includes('--new-regressions') ? ['cancelled'] : ['conditional', 'allow', 'empty', 'failed', 'closed', 'cancelled', 'unrelated_then_timeout'];
for (const outcome of cases) {
  try { await exercise(outcome); } catch (error) { failures.push(`${outcome}: ${error.message}`); }
}
for (const native of [{ provider: 'gemini_live', preface: true }, { provider: 'gemini_live', preface: false }, { provider: 'nova_sonic' }]) {
  try { await exercise('native', native); } catch (error) { failures.push(`${native.provider}/${native.preface ? 'preface' : 'no-preface'}: ${error.message}`); }
}
assert.deepEqual(failures, [], failures.join('\n'));
console.log('voice confirmation: complete original transcript, conditional revision, explicit permission, missing evidence, cancellation and cleanup passed');
