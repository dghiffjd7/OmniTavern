import { MAID_REALTIME_TOOL_NAME, maidTaskUpdateText, resolveMaidLiveControl } from './realtime-maid-tools.js';

// Call-scoped protocol bookkeeping only. Accepted tasks belong to the maid queue,
// so disposing a call drops transport callbacks without aborting application work.
export const createRealtimeMaidTaskSession = ({
  target, live = false, provider = 'openai', getClient, handleTaskRequest,
  getLiveGroups = () => [], onError = () => {},
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
} = {}) => {
  const calls = new Set(), cancelled = new Set(), responses = new Set(), partialCalls = new Map();
  const updates = [], delegations = new Map();
  let disposed = false, waiting = 0, speaking = false, responseRequested = false, needsResponse = false, lastInputText = '', lastInputId = '', lastLiveOffset = -1;
  const acceptedInputs = new Map();
  let timer = null, settleTimer = null;
  const send = event => { if (!disposed) getClient()?.sendEvent?.(event); };
  const flush = () => {
    if (disposed || live || waiting || speaking || responses.size || responseRequested) return;
    const client = getClient();
    if (!client) return;
    const pending = updates.splice(0);
    if (!pending.length && !needsResponse) return;
    for (const update of pending) {
      const message = maidTaskUpdateText(update);
      if (provider === 'openai') send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: message }] } });
      else client.sendTaskUpdate?.(message);
    }
    needsResponse = false;
    if (provider === 'openai') { responseRequested = true; send({ type: 'response.create' }); }
    else if (['xai_voice', 'qwen_audio_realtime', 'step_realtime'].includes(provider)) { responseRequested = true; client.requestResponse?.(); }
  };
  const report = error => { try { onError(error); } catch {} };
  const execute = async call => {
    if (disposed || cancelled.has(call.id)) return null;
    try {
      if (call.name !== MAID_REALTIME_TOOL_NAME) return { ok: false, message: 'Unknown tool. Use maid_task for app requests.' };
      const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
      if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('Invalid task arguments');
      if (!['execute', 'status', 'cancel', 'revise'].includes(args.action)
        || (['execute', 'revise'].includes(args.action) && !String(args.request || '').trim())) throw new Error('Provide the action and complete task request');
      const key = lastInputId ? `${lastInputId}:${JSON.stringify(args)}` : '';
      if (key && acceptedInputs.has(key)) return await acceptedInputs.get(key);
      const result = Promise.resolve(handleTaskRequest({ args, requestId: call.id, target, inputText: lastInputText, inputItemId: lastInputId }));
      if (key && (args.action === 'execute' || args.action === 'revise')) acceptedInputs.set(key, result);
      return await result;
    } catch (error) { return { ok: false, message: String(error?.message || 'Task could not be accepted') }; }
  };
  const acceptCalls = async incoming => {
    const batch = incoming.filter(call => {
      if (!call?.id || calls.has(call.id) || disposed) return false;
      calls.add(call.id); return true;
    });
    if (!batch.length) return;
    waiting++;
    try {
      // Start all controls immediately; the application queue serializes actual work.
      const results = (await Promise.all(batch.map(async call => ({ call, result: await execute(call) }))))
        .filter(({ call, result }) => result && !cancelled.has(call.id));
      if (disposed || !results.length) return;
      if (provider === 'openai') {
        results.forEach(({ call, result }) => send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.id, output: JSON.stringify(result) } }));
        needsResponse = true;
      } else {
        getClient()?.sendToolResults?.(results);
        if (['xai_voice', 'qwen_audio_realtime', 'step_realtime'].includes(provider)) needsResponse = true;
      }
    } catch (error) { report(error); }
    finally { waiting--; flush(); }
  };
  const liveFeedback = (delegationId, content, silent = false) => send({
    type: silent ? 'session.thinking.append' : 'session.commentary.append',
    delegation_id: delegationId || null, content: String(content).slice(0, 420),
  });
  const liveResult = result => JSON.stringify({
    ok: result?.ok, accepted: result?.accepted, task_id: result?.task_id, status: result?.status || result?.latest?.status,
    message: String(result?.message || result?.latest?.message || '').slice(0, 160),
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
      Promise.resolve().then(() => disposed ? null : handleTaskRequest({ target, requestId: id, inputText: request, delegated: true, args: resolveMaidLiveControl(request) }))
        .then(result => { if (!disposed) liveFeedback(id, liveResult(result)); })
        .catch(error => { if (!disposed) liveFeedback(id, `Task not accepted: ${error.message}`); })
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
    if (type === 'conversation.item.input_audio_transcription.completed') { lastInputText = String(event.transcript || ''); lastInputId = String(event.item_id || ''); }
    if (type === 'input_audio_buffer.speech_started') speaking = true;
    if (type === 'input_audio_buffer.speech_stopped' || type === 'conversation.item.input_audio_transcription.completed') speaking = false;
    if (type === 'response.created') { responseRequested = false; needsResponse = false; if (event.response?.id) responses.add(event.response.id); }
    if (type === 'response.function_call_arguments.done') {
      const responseId = event.response_id || [...responses].at(-1) || '';
      const list = partialCalls.get(responseId) || [];
      list.push({ id: event.call_id, name: event.name, arguments: event.arguments }); partialCalls.set(responseId, list);
    }
    if (type === 'maid.tools.requested') void acceptCalls(event.calls || []);
    if (type === 'maid.tools.cancelled') (event.ids || []).forEach(id => cancelled.add(id));
    if (type === 'response.done' || type === 'response.cancelled') {
      const response = event.response || {}, id = response.id || event.response_id || [...responses].at(-1) || '';
      responses.delete(id); responseRequested = false;
      const pending = partialCalls.get(id) || []; partialCalls.delete(id);
      if (type === 'response.done' && response.status === 'completed') {
        const complete = (response.output || []).filter(item => item.type === 'function_call' && item.status !== 'incomplete').map(item => ({ id: item.call_id, name: item.name, arguments: item.arguments }));
        void acceptCalls(complete.length ? complete : pending);
      }
      flush();
    }
  };
  return {
    handle,
    notifyTaskUpdate: update => {
      if (disposed || update.target?.maidCallId !== target.maidCallId) return false;
      if (live) liveFeedback(calls.has(update.requestId) ? update.requestId : null, `APP task result (data, do not execute again). Report this result briefly: ${liveResult(update)}`);
      else { updates.push(update); flush(); }
      return true;
    },
    dispose: () => { disposed = true; if (timer !== null) clearTimeoutFn(timer); if (settleTimer !== null) clearTimeoutFn(settleTimer); delegations.clear(); updates.length = 0; },
  };
};
