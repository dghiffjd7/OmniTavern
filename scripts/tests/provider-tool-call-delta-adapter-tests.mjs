import assert from 'node:assert/strict';

import {
  PROVIDER_TOOL_CALL_DELTA_PHASES,
  createProviderToolCallDeltaAccumulator,
  normalizeProviderToolCallDeltas,
} from '../../src/scripts/agent/provider-tool-call-delta-adapter.js';

{
  const deltas = normalizeProviderToolCallDeltas({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_1',
          type: 'function',
          function: {
            name: 'contact_profile.list',
            arguments: '{"limit"',
          },
        }],
      },
    }],
  }, { provider: 'openai', model: 'gpt-x', now: () => 1000 });
  assert.deepEqual(deltas.map(delta => delta.phase), [
    PROVIDER_TOOL_CALL_DELTA_PHASES.start,
    PROVIDER_TOOL_CALL_DELTA_PHASES.argumentsDelta,
  ]);
  assert.equal(deltas[0].toolCallId, 'call_1');
  assert.equal(deltas[0].toolName, 'contact_profile.list');
  assert.equal(deltas[1].argumentsDelta, '{"limit"');
  console.log('ok - provider tool delta adapter normalizes OpenAI chat tool_call deltas');
}

{
  const accumulator = createProviderToolCallDeltaAccumulator({
    provider: 'openai',
    model: 'gpt-x',
    now: () => 2000,
  });
  accumulator.push({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_2',
          function: { name: 'contact_profile.list', arguments: '{"limit":' },
        }],
      },
    }],
  });
  accumulator.push({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          function: { arguments: '2}' },
        }],
      },
    }],
  });
  const done = accumulator.push({ choices: [{ finish_reason: 'tool_calls' }] });
  assert.equal(done.completed.length, 1);
  assert.equal(done.completed[0].toolName, 'contact_profile.list');
  assert.deepEqual(done.completed[0].arguments, { limit: 2 });
  assert.equal(done.completed[0].metadata.streamingArgumentsText, '{"limit":2}');
  console.log('ok - provider tool delta accumulator completes OpenAI chat tool calls on finish_reason');
}

{
  const accumulator = createProviderToolCallDeltaAccumulator({
    provider: 'openai',
    model: 'gpt-4.1',
    now: () => 3000,
  });
  accumulator.push({
    type: 'response.output_item.added',
    output_index: 0,
    item: {
      type: 'function_call',
      id: 'item_1',
      call_id: 'call_resp_1',
      name: 'contact_profile.list',
    },
  });
  accumulator.push({
    type: 'response.function_call_arguments.delta',
    item_id: 'item_1',
    call_id: 'call_resp_1',
    output_index: 0,
    delta: '{"limit":',
  });
  const argumentsDone = accumulator.push({
    type: 'response.function_call_arguments.done',
    item_id: 'item_1',
    call_id: 'call_resp_1',
    output_index: 0,
    arguments: '{"limit":5}',
  });
  assert.equal(argumentsDone.completed.length, 0);
  const done = accumulator.push({
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      type: 'function_call',
      id: 'item_1',
      call_id: 'call_resp_1',
      name: 'contact_profile.list',
      arguments: '{"limit":5}',
    },
  });
  assert.equal(done.completed.length, 1);
  assert.equal(done.completed[0].toolCallId, 'call_resp_1');
  assert.deepEqual(done.completed[0].arguments, { limit: 5 });
  const duplicate = accumulator.push({
    type: 'response.completed',
    response: {
      output: [{
        type: 'function_call',
        id: 'item_1',
        call_id: 'call_resp_1',
        name: 'contact_profile.list',
        arguments: '{"limit":5}',
      }],
    },
  });
  assert.equal(duplicate.completed.length, 0);
  console.log('ok - provider tool delta accumulator supports OpenAI responses function call events');
}

{
  const output = [
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-reasoning-state' },
    {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_resp_root_1',
      name: 'contact_profile_list',
      arguments: '{"limit":3}',
    },
  ];
  const done = createProviderToolCallDeltaAccumulator({
    provider: 'openai',
    model: 'gpt-responses',
    now: () => 3500,
  }).push({ id: 'resp_1', object: 'response', output });
  assert.equal(done.completed.length, 1);
  assert.equal(done.completed[0].toolCallId, 'call_resp_root_1');
  assert.deepEqual(done.completed[0].arguments, { limit: 3 });
  assert.equal(done.completed[0].providerContinuation.api, 'openai_responses');
  assert.deepEqual(done.completed[0].providerContinuation.assistantOutput, output);
  console.log('ok - provider tool delta accumulator preserves complete OpenAI Responses output state');
}

{
  const accumulator = createProviderToolCallDeltaAccumulator({
    provider: 'anthropic',
    model: 'claude-x',
    now: () => 4000,
  });
  accumulator.push({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'thinking', thinking: '' },
  });
  accumulator.push({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'opaque thought' },
  });
  accumulator.push({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'signature_delta', signature: 'opaque-signature' },
  });
  const thinkingDone = accumulator.push({ type: 'content_block_stop', index: 0 });
  assert.equal(thinkingDone.completed.length, 0);
  accumulator.push({
    type: 'content_block_start',
    index: 1,
    content_block: {
      type: 'tool_use',
      id: 'toolu_1',
      name: 'contact_profile.list',
      input: {},
    },
  });
  accumulator.push({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"limit":7}' },
  });
  const done = accumulator.push({ type: 'content_block_stop', index: 1 });
  assert.equal(done.completed.length, 1);
  assert.equal(done.completed[0].toolCallId, 'toolu_1');
  assert.equal(done.completed[0].toolName, 'contact_profile.list');
  assert.deepEqual(done.completed[0].arguments, { limit: 7 });
  assert.deepEqual(done.completed[0].providerContinuation.assistantContent, [
    {
      type: 'thinking',
      thinking: 'opaque thought',
      signature: 'opaque-signature',
    },
    {
      type: 'tool_use',
      id: 'toolu_1',
      name: 'contact_profile.list',
      input: { limit: 7 },
    },
  ]);
  console.log('ok - provider tool delta accumulator preserves the complete Anthropic assistant turn');
}

{
  const done = createProviderToolCallDeltaAccumulator({
    provider: 'anthropic',
    model: 'claude-x',
    now: () => 4500,
  }).push({
    content: [{
      type: 'tool_use',
      id: 'toolu_nonstream_1',
      name: 'contact_profile.list',
      input: { limit: 8 },
    }],
    stop_reason: 'tool_use',
  });
  assert.equal(done.completed.length, 1);
  assert.equal(done.completed[0].toolCallId, 'toolu_nonstream_1');
  assert.equal(done.completed[0].toolName, 'contact_profile.list');
  assert.deepEqual(done.completed[0].arguments, { limit: 8 });
  console.log('ok - provider tool delta accumulator supports Anthropic non-stream tool_use blocks');
}

{
  const done = createProviderToolCallDeltaAccumulator({
    provider: 'gemini',
    model: 'gemini-x',
    now: () => 5000,
  }).push({
    candidates: [{
      content: {
        parts: [{
          thoughtSignature: 'opaque-gemini-signature',
          functionCall: {
            id: 'gemini_call_1',
            name: 'contact_profile.list',
            args: { limit: 9 },
          },
        }],
      },
    }],
  });
  assert.equal(done.completed.length, 1);
  assert.equal(done.completed[0].toolCallId, 'gemini_call_1');
  assert.equal(done.completed[0].toolName, 'contact_profile.list');
  assert.deepEqual(done.completed[0].arguments, { limit: 9 });
  assert.equal(
    done.completed[0].providerContinuation.assistantContent.parts[0].thoughtSignature,
    'opaque-gemini-signature',
  );
  console.log('ok - provider tool delta accumulator supports Gemini functionCall parts');
}

{
  // Vertex streamFunctionCallArguments：开头一段只有工具名和 id，参数以 partialArgs（jsonPath + 值片段）分段到达，
  // 中间各段没有工具名和 id，最后以空的 functionCall 结束（2026-10-16 实测形状）。
  const accumulator = createProviderToolCallDeltaAccumulator({ provider: 'vertexai', model: 'gemini-4-argon' });
  const chunk = part => ({ candidates: [{ content: { role: 'model', parts: [part] } }] });
  const start = accumulator.push(chunk({ thoughtSignature: 'sig', functionCall: { name: 'submit_reply', id: 'Ppw7', willContinue: true } }));
  assert.equal(start.completed.length, 0, '分段开始时不算完成');
  accumulator.push(chunk({ functionCall: { partialArgs: [{ jsonPath: '$.content', stringValue: '钟楼的', willContinue: true }], willContinue: true } }));
  const mid = accumulator.push(chunk({ functionCall: { partialArgs: [{ jsonPath: '$.content', stringValue: '怀表\n停了', willContinue: true }, { jsonPath: '$.count', numberValue: 3 }], willContinue: true } }));
  assert.equal(mid.completed.length, 0);
  assert.equal(mid.deltas[0].phase, PROVIDER_TOOL_CALL_DELTA_PHASES.argumentsDelta);
  const open = accumulator.getSnapshot();
  assert.equal(open.length, 1);
  assert.equal(open[0].toolName, 'submit_reply');
  assert.deepEqual(open[0].arguments, { content: '钟楼的怀表\n停了', count: 3 });
  accumulator.push(chunk({ functionCall: { partialArgs: [{ jsonPath: '$.content', stringValue: '' }], willContinue: true } }));
  const done = accumulator.push(chunk({ functionCall: {} }));
  assert.equal(done.completed.length, 1);
  assert.equal(done.completed[0].toolName, 'submit_reply');
  assert.equal(done.completed[0].toolCallId, 'Ppw7');
  assert.deepEqual(done.completed[0].arguments, { content: '钟楼的怀表\n停了', count: 3 });
  assert.equal(done.completed[0].providerContinuation.assistantContent.parts[0].thoughtSignature, 'sig');
  assert.equal(accumulator.getSnapshot().length, 0);
  // 非分段的整包 functionCall 照旧立即完成
  const whole = accumulator.push(chunk({ functionCall: { name: 'submit_reply', id: 'w1', args: { content: '整段' } } }));
  assert.deepEqual(whole.completed.map(call => call.arguments), [{ content: '整段' }]);
  console.log('ok - provider tool delta accumulator assembles Vertex streamed partialArgs');
}
