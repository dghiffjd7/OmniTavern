import assert from 'node:assert/strict';

import {
  PROVIDER_TOOL_NATIVE_RUNNER_CONTRACTS,
  PROVIDER_TOOL_NATIVE_RUNNER_ENTRYPOINT,
  resolveProviderToolNativeRunnerContract,
} from '../../src/scripts/agent/provider-tool-native-runner-contract.js';

const buildDraft = (overrides = {}) => ({
  ok: true,
  status: 'ready',
  output: 'provider_stream_events',
  network: false,
  writesChat: false,
  provider: 'anthropic',
  model: 'claude-contract',
  sessionId: 's-native',
  payloadKind: 'messages',
  payloadCount: 2,
  requestPreviewFormat: 'anthropic_messages_tool_result',
  request: {
    provider: 'anthropic',
    model: 'claude-contract',
    sessionId: 's-native',
    format: 'anthropic_messages_tool_result',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu-1', name: 'contact_profile.list', input: { limit: 1 } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu-1', content: '{"summary":"listed"}' }],
      },
    ],
  },
  ...overrides,
});

{
  const contract = resolveProviderToolNativeRunnerContract({
    runnerRequestDraft: buildDraft(),
  });
  assert.equal(contract.ok, true);
  assert.equal(contract.status, 'ready');
  assert.equal(contract.contractKind, PROVIDER_TOOL_NATIVE_RUNNER_CONTRACTS.anthropicMessages);
  assert.equal(contract.entrypoint, PROVIDER_TOOL_NATIVE_RUNNER_ENTRYPOINT);
  assert.equal(contract.providerFamily, 'anthropic');
  assert.equal(contract.toolUseCount, 1);
  assert.equal(contract.toolResultCount, 1);
  assert.equal(contract.network, false);
  assert.equal(contract.writesChat, false);
  assert.equal(contract.forbiddenInputs.includes('window.appBridge'), true);
  console.log('ok - provider native runner contract accepts Anthropic tool_result messages');
}

{
  const contract = resolveProviderToolNativeRunnerContract({
    runnerRequestDraft: buildDraft({
      provider: 'openai',
      payloadKind: 'input',
      requestPreviewFormat: 'openai_responses_function_call_output',
      request: {
        provider: 'openai',
        model: 'gpt-responses',
        format: 'openai_responses_function_call_output',
        input: [
          { type: 'function_call', call_id: 'call-1', name: 'contact_profile_list', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call-1', output: '{"summary":"ok"}' },
        ],
      },
    }),
  });
  assert.equal(contract.ok, true);
  assert.equal(contract.contractKind, PROVIDER_TOOL_NATIVE_RUNNER_CONTRACTS.openaiResponses);
  assert.equal(contract.functionCallCount, 1);
  assert.equal(contract.functionCallOutputCount, 1);
  assert.equal(contract.requiresProviderNativeRunner, true);
  console.log('ok - provider native runner contract accepts official OpenAI Responses continuation input');
}

{
  const contract = resolveProviderToolNativeRunnerContract({
    runnerRequestDraft: buildDraft({
      provider: 'openai',
      payloadKind: 'input',
      requestPreviewFormat: 'openai_responses_function_call_output',
      request: {
        provider: 'openai',
        sourceProvider: 'custom',
        format: 'openai_responses_function_call_output',
        input: [{ type: 'function_call_output', call_id: 'call-1', output: '{}' }],
      },
    }),
  });
  assert.equal(contract.ok, true);
  assert.equal(contract.contractKind, PROVIDER_TOOL_NATIVE_RUNNER_CONTRACTS.openaiResponses);
  console.log('ok - provider native runner contract accepts compatible Responses items; the client validates configured protocol');
}

{
  const contract = resolveProviderToolNativeRunnerContract({
    runnerRequestDraft: buildDraft({
      provider: 'vertexai',
      model: 'gemini-contract',
      payloadKind: 'contents',
      requestPreviewFormat: 'gemini_function_response',
      request: {
        provider: 'vertexai',
        model: 'gemini-contract',
        sessionId: 's-native',
        format: 'gemini_function_response',
        contents: [
          { role: 'model', parts: [{ functionCall: { name: 'contact_profile.list', args: { limit: 1 } } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'contact_profile.list', response: { summary: 'listed' } } }] },
        ],
      },
    }),
  });
  assert.equal(contract.ok, true);
  assert.equal(contract.status, 'ready');
  assert.equal(contract.contractKind, PROVIDER_TOOL_NATIVE_RUNNER_CONTRACTS.geminiContents);
  assert.equal(contract.providerFamily, 'gemini');
  assert.equal(contract.functionCallCount, 1);
  assert.equal(contract.functionResponseCount, 1);
  assert.deepEqual(contract.requestKeys, ['contents']);
  console.log('ok - provider native runner contract accepts Gemini and Vertex functionResponse contents');
}

{
  const contract = resolveProviderToolNativeRunnerContract({
    runnerRequestDraft: buildDraft({
      provider: 'openai',
      payloadKind: 'messages',
      requestPreviewFormat: 'openai_chat_completions_tool_result',
      request: {
        provider: 'openai',
        model: 'gpt-contract',
        sessionId: 's-native',
        format: 'openai_chat_completions_tool_result',
        messages: [
          { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'contact_profile.list', arguments: '{"limit":1}' } }] },
          { role: 'tool', tool_call_id: 'call-1', content: '{"summary":"listed"}' },
        ],
      },
    }),
  });
  assert.equal(contract.ok, true);
  assert.equal(contract.contractKind, PROVIDER_TOOL_NATIVE_RUNNER_CONTRACTS.openaiMessages);
  assert.equal(contract.requiresProviderNativeRunner, false);
  assert.equal(contract.toolMessageCount, 1);
  console.log('ok - provider native runner contract also describes OpenAI native message payloads');
}

{
  const contract = resolveProviderToolNativeRunnerContract({
    runnerRequestDraft: buildDraft({
      request: {
        provider: 'anthropic',
        format: 'anthropic_messages_tool_result',
        messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu-1' }] }],
      },
    }),
  });
  assert.equal(contract.ok, false);
  assert.equal(contract.status, 'unsupported');
  assert.equal(contract.reason.includes('tool_result'), true);
  console.log('ok - provider native runner contract rejects malformed Anthropic messages');
}

{
  const contract = resolveProviderToolNativeRunnerContract({
    runnerRequestDraft: buildDraft({
      provider: 'gemini',
      payloadKind: 'contents',
      requestPreviewFormat: 'gemini_function_response',
      request: {
        provider: 'gemini',
        format: 'gemini_function_response',
        contents: [{ role: 'model', parts: [{ functionCall: { name: 'contact_profile.list', args: {} } }] }],
      },
    }),
  });
  assert.equal(contract.ok, false);
  assert.equal(contract.status, 'unsupported');
  assert.equal(contract.reason.includes('functionResponse'), true);
  console.log('ok - provider native runner contract rejects malformed Gemini contents');
}
