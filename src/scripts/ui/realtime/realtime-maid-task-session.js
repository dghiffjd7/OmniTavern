import { MAID_REALTIME_TOOL_NAME, isMaidExecuteAccepted, neutralMaidAcceptedReceipt, maidTaskUpdateText, maidResultBasisForUpdate, resolveMaidLiveControl } from './realtime-maid-tools.js';
import { t } from '../../i18n/index.js';

// Call-scoped protocol bookkeeping only. Accepted tasks belong to the maid queue,
// so disposing a call drops transport callbacks without aborting application work.
export const createRealtimeMaidTaskSession = ({
  target, live = false, provider = 'openai', getClient, handleTaskRequest,
  getLiveGroups = () => [], isOutputAudible = () => true, onError = () => {},
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
} = {}) => {
  const calls = new Set(), cancelled = new Set(), responses = new Set(), partialCalls = new Map();
  const unexecutedNotices = new Set();
  const confirmationInputs = new Map();
  const confirmationUsesResponseInput = ['gemini_live', 'nova_sonic'].includes(provider);
  const updates = [], delegations = new Map();
  const turns = new Map(), responseRecords = new Map(), responseContexts = new Map(), audioBuffers = new Set(), pendingAcknowledgements = new Set();
  const makeTurn = id => ({ id, text: '', transcription: 'pending', responses: new Set(), acknowledgementRequested: false });
  let turnSequence = 0, currentTurn = makeTurn(''), speakingTurn = null, nextResponseContext = null, controlResponseContext = null;
  let disposed = false, waiting = 0, speaking = false, responseRequested = false, needsResponse = false, lastLiveOffset = -1;
  const acceptedInputs = new Map();
  let timer = null, settleTimer = null;
  const send = event => { if (!disposed) getClient()?.sendEvent?.(event); };
  const selectTurn = (id, { started = false } = {}) => {
    if (id && turns.has(id)) {
      const turn = turns.get(id);
      if (turn.sequence >= (currentTurn.sequence || 0)) currentTurn = turn;
      return turn;
    }
    if (!started && !currentTurn.id && currentTurn.inputStarted) currentTurn.id = id;
    else if (started || id !== currentTurn.id) currentTurn = makeTurn(id);
    if (started) currentTurn.inputStarted = true;
    currentTurn.sequence ||= ++turnSequence;
    if (id) turns.set(id, currentTurn);
    if (turns.size > 128) turns.delete(turns.keys().next().value);
    return currentTurn;
  };
  const responseRecord = id => {
    if (!id) return null;
    if (!responseRecords.has(id)) {
      const record = { id, turn: currentTurn, inputTurn: null, audible: false, interrupted: false };
      responseRecords.set(id, record); currentTurn.responses.add(record);
      if (responseRecords.size > 128) responseRecords.delete(responseRecords.keys().next().value);
    }
    return responseRecords.get(id);
  };
  const hasAudio = turn => [...turn.responses].some(record => record.audible && !record.interrupted);
  const responseContext = (kind, automatic) => ({
    maidTranscriptKind: kind, maidTranscriptAutomatic: automatic,
    // A model continuation may also contain conversation or a useful question.
    // Scheduling it for a receipt does not prove its whole transcript is a receipt.
    maidTranscriptContentOnly: false,
  });
  const flush = () => {
    if (disposed || live || waiting || speaking || responses.size || audioBuffers.size || responseRequested) return;
    const client = getClient();
    if (!client) return;
    const pending = updates.splice(0);
    const acknowledgement = [...pendingAcknowledgements].find(turn => turn === currentTurn && !turn.acknowledgementRequested && !hasAudio(turn));
    pendingAcknowledgements.clear();
    if (!pending.length && !needsResponse && !acknowledgement) return;
    for (const update of pending) {
      const message = maidTaskUpdateText(update);
      if (provider === 'openai') send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: message }] } });
      else client.sendTaskUpdate?.(message);
    }
    nextResponseContext = !pending.length && !needsResponse && acknowledgement
      ? { turn: acknowledgement, metadata: responseContext('ack', true) }
      : (!pending.length && controlResponseContext ? { turn: currentTurn, metadata: controlResponseContext } : null);
    if (acknowledgement) acknowledgement.acknowledgementRequested = true;
    needsResponse = false; controlResponseContext = null;
    if (provider === 'openai') { responseRequested = true; send({ type: 'response.create' }); }
    else if (['xai_voice', 'qwen_audio_realtime', 'step_realtime', 'custom'].includes(provider)) { responseRequested = true; client.requestResponse?.(); }
  };
  const report = error => { try { onError(error); } catch {} };
  const settleConfirmationInput = (callId, turn = null) => {
    const pending = confirmationInputs.get(callId);
    if (!pending) return;
    confirmationInputs.delete(callId); clearTimeoutFn(pending.timer); pending.resolve(turn);
  };
  const confirmationInput = source => {
    const turn = confirmationUsesResponseInput ? source?.inputTurn : source;
    if (!turn || turn.transcription === 'pending') return undefined;
    return turn.transcription === 'completed' && turn.text.trim() ? turn : null;
  };
  const refreshConfirmationInputs = () => {
    for (const [id, pending] of confirmationInputs) {
      const turn = confirmationInput(pending.source);
      if (turn !== undefined) settleConfirmationInput(id, turn);
    }
  };
  const waitForConfirmationInput = (callId, source) => {
    if (!source) return Promise.resolve(null);
    const turn = confirmationInput(source);
    if (turn !== undefined) return Promise.resolve(turn);
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const timer = setTimeoutFn(() => settleConfirmationInput(callId), 10000);
    confirmationInputs.set(callId, { source, resolve, timer });
    return promise;
  };
  const execute = async (call, turn, record) => {
    if (disposed || cancelled.has(call.id)) return null;
    try {
      if (call.name !== MAID_REALTIME_TOOL_NAME) return { result: { ok: false, message: 'Unknown tool. Use maid_task for app requests.' } };
      const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
      if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('Invalid task arguments');
      if (!['execute', 'status', 'cancel', 'revise', 'confirm'].includes(args.action)
        || (['execute', 'revise'].includes(args.action) && !String(args.request || '').trim())) throw new Error('Provide the action and complete task request');
      // Permission depends on the complete user words, not the model's shorter
      // tool arguments. Service completion can precede final ASR transcription.
      const inputTurn = args.action === 'confirm'
        ? await waitForConfirmationInput(call.id, confirmationUsesResponseInput ? record : turn) : turn;
      if (disposed || cancelled.has(call.id)) return null;
      if (!inputTurn) return { args, result: { ok: false, reason: 'confirmation_transcript_unavailable', message: t('请明确说「允许」或「取消」。') } };
      const inputText = inputTurn.text, inputItemId = inputTurn.id;
      const key = inputItemId ? `${inputItemId}:${JSON.stringify(args)}` : '';
      if (key && acceptedInputs.has(key)) return { args, result: await acceptedInputs.get(key) };
      const result = Promise.resolve(handleTaskRequest({ args, requestId: call.id, target, inputText, inputItemId }));
      if (key && (args.action === 'execute' || args.action === 'revise')) acceptedInputs.set(key, result);
      return { args, result: await result };
    } catch (error) { return { result: { ok: false, message: String(error?.message || 'Task could not be accepted') } }; }
  };
  const acceptCalls = async (incoming, originResponseId = '') => {
    const record = responseRecords.get(originResponseId), turn = record?.turn || currentTurn;
    const batch = incoming.filter(call => {
      if (!call?.id || calls.has(call.id) || disposed) return false;
      calls.add(call.id); return true;
    });
    if (!batch.length) return;
    waiting++;
    try {
      // Start all controls immediately; the application queue serializes actual work.
      const results = (await Promise.all(batch.map(async call => ({ call, ...await execute(call, turn, record) }))))
        .filter(({ call, result }) => result && !cancelled.has(call.id));
      if (disposed || !results.length) return;
      const receipts = results.map(({ call, args, result }) => ({ call, result: isMaidExecuteAccepted(args, result) ? neutralMaidAcceptedReceipt(result) : result }));
      const controls = results.filter(({ args, result }) => !isMaidExecuteAccepted(args, result));
      const explicitlyResumed = provider === 'openai' || ['xai_voice', 'qwen_audio_realtime', 'step_realtime', 'custom'].includes(provider);
      if (explicitlyResumed) {
        if (controls.length) {
          needsResponse = true;
          controlResponseContext = controls.every(({ args }) => args?.action === 'status') ? responseContext('status', false) : null;
        } else pendingAcknowledgements.add(turn);
      }
      if (provider === 'openai') {
        receipts.forEach(({ call, result }) => send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.id, output: JSON.stringify(result) } }));
      } else {
        // Gemini/Nova resume from required tool results themselves. Preserve that
        // protocol path; an app-side response request would add another answer.
        getClient()?.sendToolResults?.(receipts);
      }
    } catch (error) { report(error); }
    finally { waiting--; flush(); }
  };
  const liveFeedback = (delegationId, content, silent = false) => send({
    type: silent ? 'session.thinking.append' : 'session.commentary.append',
    // Payload fields are bounded before serialization. Cutting JSON here can
    // remove the task ID, a permission outcome, or the result's evidence.
    delegation_id: delegationId || null, content: String(content),
  });
  const liveResult = result => JSON.stringify({
    ok: result?.ok, accepted: result?.accepted, task_id: result?.task_id, status: result?.status || result?.latest?.status,
    message: String(result?.message || result?.latest?.message || '').slice(0, 160),
    resultBasis: maidResultBasisForUpdate(result?.resultBasis || result?.latest?.resultBasis),
    ...(result?.active ? { active: result.active.slice(0, 2).map(task => ({ status: task.status, message: String(task.message || '').slice(0, 50) })) } : {}),
  });
  const processDelegations = () => {
    if (disposed) return;
    for (const [id, delegation] of delegations) {
      const fragments = getLiveGroups().filter(group => group.role === 'user').flatMap(group => group.fragments || [])
        .filter(fragment => Number.isFinite(fragment.startMs) && Number.isFinite(fragment.endMs) && fragment.startMs <= delegation.offset && fragment.endMs > lastLiveOffset)
        .sort((a, b) => a.startMs - b.startMs);
      if (!fragments.length) continue;
      const request = fragments.map(fragment => fragment.delta).join('').trim();
      if (!request) continue;
      delegations.delete(id); lastLiveOffset = Math.max(lastLiveOffset, delegation.offset, ...fragments.map(fragment => fragment.endMs));
      // Delegation is the authoritative request boundary. Transcript display groups
      // are revisable and never start work by themselves.
      waiting++;
      const args = resolveMaidLiveControl(request);
      Promise.resolve().then(async () => {
        if (disposed) return null;
        if (args.action === 'revise') {
          const status = await handleTaskRequest({ target, requestId: `${id}:revision-target`, inputText: request, delegated: true, args: { action: 'status' } });
          if (disposed) return null;
          if (status?.ok === false) return status;
          const active = (status?.active || []).filter(task => task?.task_id);
          if (active.length > 1) return { ok: false, reason: 'ambiguous_revision_target', message: t('有多个进行中的任务，请说明要修正哪一个') };
          if (active.length === 1) args.task_id = active[0].task_id;
        }
        return handleTaskRequest({ target, requestId: id, inputText: request, delegated: true, args });
      })
        .then(result => {
          if (disposed) return;
          const accepted = isMaidExecuteAccepted(args, result);
          liveFeedback(id, accepted ? JSON.stringify(neutralMaidAcceptedReceipt(result)) : liveResult(result), accepted);
        })
        .catch(error => { if (!disposed) liveFeedback(id, `Task not accepted: ${String(error.message || '').slice(0, 300)}`); })
        .finally(() => { waiting--; });
    }
    if (!delegations.size && timer !== null) { clearTimeoutFn(timer); timer = null; }
  };
  const settleDelegations = () => {
    if (!delegations.size) return;
    if (settleTimer !== null) clearTimeoutFn(settleTimer);
    settleTimer = setTimeoutFn(() => { settleTimer = null; processDelegations(); }, 250);
  };
  const handle = event => {
    if (disposed) return;
    const type = event.type;
    if (live) {
      if (type === 'session.delegation.created' && event.delegation?.target === 'client') {
        const id = event.delegation.id, offset = Number(event.offset_ms);
        if (!id || calls.has(id) || !Number.isFinite(offset)) return;
        calls.add(id); delegations.set(id, { offset });
        settleDelegations();
        if (delegations.size && timer === null) timer = setTimeoutFn(() => {
          timer = null;
          for (const [pendingId] of delegations) liveFeedback(pendingId, 'No new request transcript is available. Ask the user to repeat the request; no task was started.');
          delegations.clear();
        }, 2000);
      } else if (type === 'session.input_transcript.delta') settleDelegations();
      return;
    }
    if (type === 'maid.tools.not_executed') {
      // These transports accept context without starting a model response. A
      // cancelled service call is not a function result and never starts work.
      if (!['xai_voice', 'qwen_audio_realtime', 'step_realtime', 'custom'].includes(provider)
        || !['cancelled', 'incomplete'].includes(event.reason)) return;
      const ids = [...new Set((event.calls || []).filter(call => call?.id && call.name === MAID_REALTIME_TOOL_NAME
        && !calls.has(call.id) && !unexecutedNotices.has(call.id)).map(call => call.id))];
      const client = getClient();
      if (!ids.length || !client?.sendTaskUpdate) return;
      try {
        client.sendTaskUpdate(`APP tool dispatch status (data, not a user request): ${JSON.stringify({
          type: 'maid_tool_not_executed', call_ids: ids, response_id: event.response_id, reason: event.reason,
        })}\nThe listed calls were interrupted before app acceptance and were not executed. A spoken acknowledgement did not start work. Use the user's latest complete request to decide whether a fresh maid_task call is needed; preserve all current restrictions and permission checks. This status update does not request a spoken response.`);
        ids.forEach(id => unexecutedNotices.add(id));
      } catch (error) { report(error); }
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      const turn = selectTurn(String(event.item_id || ''));
      turn.text = String(event.transcript || '');
      turn.transcription = 'completed';
      // Native providers can start the response before their final input text.
      // Their local response id keeps task evidence attached to the right input.
      const record = responseRecord(event.response_id);
      if (record && record.turn !== turn) { record.turn.responses.delete(record); record.turn = turn; turn.responses.add(record); }
      // Gemini/Nova do not always announce speech onset. Only explicit response
      // linkage can prove that a transcript belongs to their current confirmation.
      if (record) record.inputTurn = turn;
      refreshConfirmationInputs();
      if (!speakingTurn || speakingTurn === turn) speaking = false;
    }
    if (type === 'conversation.item.input_audio_transcription.failed') {
      const turn = event.item_id ? turns.get(String(event.item_id)) : currentTurn;
      if (turn) { turn.transcription = 'failed'; refreshConfirmationInputs(); }
    }
    if (type === 'input_audio_buffer.speech_started') {
      speaking = true;
      for (const id of new Set([...responses, ...audioBuffers])) { const record = responseRecords.get(id); if (record) record.interrupted = true; }
      audioBuffers.clear(); speakingTurn = selectTurn(String(event.item_id || ''), { started: true });
    }
    if (type === 'input_audio_buffer.speech_stopped' && (!event.item_id || event.item_id === speakingTurn?.id)) speaking = false;
    if (type === 'response.created') {
      responseRequested = false;
      const id = event.response?.id;
      if (id) {
        responses.add(id);
        const record = responseRecord(id);
        if (nextResponseContext) {
          record.turn.responses.delete(record); record.turn = nextResponseContext.turn; record.turn.responses.add(record);
          responseContexts.set(id, nextResponseContext.metadata);
        }
      }
      nextResponseContext = null;
    }
    if (['response.output_audio.delta', 'response.audio.delta', 'output_audio_buffer.started'].includes(type)) {
      const id = event.response_id || event.response?.id || [...responses].at(-1) || '';
      const record = responseRecord(id);
      if (record && event.playbackSuppressed !== true && event.delta !== '' && isOutputAudible()) record.audible = true;
      if (type === 'output_audio_buffer.started' && id) audioBuffers.add(id);
    }
    if (type === 'output_audio_buffer.stopped' || type === 'output_audio_buffer.cleared') {
      const id = event.response_id || event.response?.id || [...audioBuffers].at(-1) || '';
      if (type === 'output_audio_buffer.cleared') { const record = responseRecords.get(id); if (record) record.interrupted = true; }
      audioBuffers.delete(id); flush();
    }
    if (type === 'response.function_call_arguments.done') {
      const responseId = event.response_id || [...responses].at(-1) || '';
      const list = partialCalls.get(responseId) || [];
      list.push({ id: event.call_id, name: event.name, arguments: event.arguments }); partialCalls.set(responseId, list);
    }
    if (type === 'maid.tools.requested') void acceptCalls(event.calls || [], event.response_id || [...responses].at(-1) || '');
    if (type === 'maid.tools.cancelled') (event.ids || []).forEach(id => { cancelled.add(id); settleConfirmationInput(id); });
    if (type === 'response.done' || type === 'response.cancelled') {
      const response = event.response || {}, id = response.id || event.response_id || [...responses].at(-1) || '';
      const record = responseRecords.get(id);
      if (record && (type === 'response.cancelled' || ['cancelled', 'incomplete'].includes(response.status))) record.interrupted = true;
      if (type === 'response.cancelled') audioBuffers.delete(id);
      responses.delete(id); responseRequested = false;
      const pending = partialCalls.get(id) || []; partialCalls.delete(id);
      if (type === 'response.done' && response.status === 'completed') {
        const output = (response.output || []).filter(item => item.type === 'function_call');
        const complete = output.filter(item => !item.status || item.status === 'completed').map(item => ({ id: item.call_id, name: item.name, arguments: item.arguments }));
        // Explicit final item status takes precedence over earlier arguments.
        void acceptCalls(output.length ? complete : pending, id);
      }
      flush();
    }
  };
  return {
    handle,
    takeResponseContext: responseId => {
      const context = responseContexts.get(responseId) || null;
      responseContexts.delete(responseId);
      return context;
    },
    notifyTaskUpdate: update => {
      if (disposed || update.target?.maidCallId !== target.maidCallId) return false;
      if (live) {
        liveFeedback(calls.has(update.requestId) ? update.requestId : null, update.kind === 'confirmation'
          ? `APP permission request (data). Ask the user whether to allow it; only an explicit "允许" or "yes" allows once: ${String(update.message || '').slice(0, 300)}`
          : `APP task result (data, do not execute again). Report the answer and its basis briefly. explanation means no tools used, not a fresh lookup; tool_execution records tool use, not verified facts. Sources are tool access or search records, not automatically verified citations. Missing or unverified basis cannot establish execution or verification. recordedAt is the recording time, not the source date: ${liveResult(update)}`);
      }
      else { updates.push(update); flush(); }
      return true;
    },
    dispose: () => {
      disposed = true; if (timer !== null) clearTimeoutFn(timer); if (settleTimer !== null) clearTimeoutFn(settleTimer);
      for (const id of confirmationInputs.keys()) settleConfirmationInput(id);
      delegations.clear(); updates.length = 0; pendingAcknowledgements.clear(); turns.clear(); responseRecords.clear(); responseContexts.clear(); audioBuffers.clear(); unexecutedNotices.clear();
    },
  };
};
