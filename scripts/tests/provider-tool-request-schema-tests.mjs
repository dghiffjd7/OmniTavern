import assert from 'node:assert/strict';

import { OpenAIProvider } from '../../src/scripts/api/providers/openai.js';
import { GeminiProvider } from '../../src/scripts/api/providers/gemini.js';
import { MakersuiteProvider } from '../../src/scripts/api/providers/makersuite.js';
import { VertexAIProvider } from '../../src/scripts/api/providers/vertexai.js';
import { createProviderToolCallDeltaAccumulator } from '../../src/scripts/agent/provider-tool-call-delta-adapter.js';
import { normalizeProviderToolCall } from '../../src/scripts/agent/provider-tool-call-parts.js';
import {
  CHAT_EMIT_PROVIDER_MODEL_CONTEXT_TOOLS,
  DEFAULT_PROVIDER_BASE_MODEL_CONTEXT_TOOLS,
  PROVIDER_TOOL_REQUEST_FORMATS,
  buildProviderToolRequestSchema,
} from '../../src/scripts/agent/provider-tool-request-schema.js';
import { createChatEmitAgentTools } from '../../src/scripts/agent/tools/chat-emit-tools.js';
import { createMemoryAgentTools } from '../../src/scripts/agent/tools/memory-tools.js';
import { createVariableAgentTools } from '../../src/scripts/agent/tools/variable-tools.js';
import { createWorldbookAgentTools } from '../../src/scripts/agent/tools/worldbook-tools.js';

const contactListTool = {
  name: 'contact_profile.list',
  title: 'List contact profiles',
  description: 'List stored contact profiles in the current scope.',
  permissions: ['storage'],
  riskLevel: 'low',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      limit: { type: 'integer', minimum: 0, maximum: 1000 },
    },
  },
};

const contactGetTool = {
  name: 'contact_profile.get',
  title: 'Get contact profile',
  description: 'Get a stored contact profile by contact id.',
  permissions: ['storage'],
  riskLevel: 'low',
  schema: {
    type: 'object',
    required: ['contactId'],
    additionalProperties: false,
    properties: {
      contactId: { type: 'string', minLength: 1 },
    },
  },
};

const [chatEmitPrivateTool] = createChatEmitAgentTools();
const memoryPreviewTool = createMemoryAgentTools({
  previewMemoryActions: async () => ({ changed: 0, skipped: 0 }),
}).find(tool => tool.name === 'memory.preview_actions');
const [variablePreviewTool] = createVariableAgentTools({
  previewVariableCommands: async () => ({ changed: 0, skipped: [] }),
});
const [worldbookPreviewTool] = createWorldbookAgentTools({
  previewWorldbookActions: async () => ({ changed: 0, skipped: 0 }),
});

const createRegistry = ({
  gate = { enabled: true, allowedTools: ['contact_profile.list'], source: 'test' },
  tools = [contactListTool],
} = {}) => ({
  actions: {
    getProviderToolSessionGate: () => gate,
    getAgentTool: name => tools.find(tool => tool.name === name) || null,
    listAgentTools: () => tools.slice(),
  },
});

{
  const schema = buildProviderToolRequestSchema({
    debugUiRegistry: createRegistry({ gate: { enabled: false, allowedTools: ['contact_profile.list'] } }),
    provider: 'openai',
    model: 'gpt-tool',
    sessionId: 's1',
  });

  assert.equal(schema.enabled, false);
  assert.equal(schema.diagnostics.reason, 'provider tool session gate is disabled');
  assert.deepEqual(schema.requestOptions, {});
  console.log('ok - provider tool request schema stays disabled until the session gate is enabled');
}

{
  const schema = buildProviderToolRequestSchema({
    debugUiRegistry: createRegistry(),
    provider: 'openai',
    model: 'gpt-tool',
    sessionId: 's1',
  });

  assert.equal(schema.enabled, true);
  assert.equal(schema.diagnostics.format, PROVIDER_TOOL_REQUEST_FORMATS.openaiResponses);
  assert.deepEqual(schema.diagnostics.internalToolNames, ['contact_profile.list']);
  assert.deepEqual(schema.diagnostics.providerToolNames, ['contact_profile_list']);
  assert.equal(schema.requestOptions.tool_choice, 'auto');
  assert.equal(schema.requestOptions.openaiApi, 'responses');
  assert.equal(schema.requestOptions.parallel_tool_calls, false);
  assert.equal(schema.requestOptions.tools[0].function.name, 'contact_profile_list');
  assert.equal(schema.requestOptions.tools[0].function.parameters.properties.limit.type, 'integer');
  console.log('ok - official OpenAI provider tool schema selects Responses with serial function tools');
}

{
  const schema = buildProviderToolRequestSchema({
    debugUiRegistry: createRegistry(),
    provider: 'openai',
    baseUrl: 'https://proxy.example/v1',
    model: 'gpt-tool',
    sessionId: 's1',
  });

  assert.equal(schema.enabled, true);
  assert.equal(schema.diagnostics.format, PROVIDER_TOOL_REQUEST_FORMATS.openai);
  assert.equal(Object.hasOwn(schema.requestOptions, 'openaiApi'), false);
  console.log('ok - proxied OpenAI-compatible provider tools stay on Chat Completions');
}

{
  const schema = buildProviderToolRequestSchema({
    debugUiRegistry: createRegistry({
      gate: { enabled: true, allowedTools: ['contact_profile.list', 'contact_profile.get'] },
      tools: [contactListTool, contactGetTool],
    }),
    provider: 'openai',
    model: 'gpt-tool',
    sessionId: 's1',
  });

  assert.equal(schema.enabled, true);
  assert.deepEqual(schema.diagnostics.internalToolNames, ['contact_profile.list', 'contact_profile.get']);
  assert.deepEqual(schema.diagnostics.providerToolNames, ['contact_profile_list', 'contact_profile_get']);
  const getTool = schema.requestOptions.tools.find(tool => tool.function.name === 'contact_profile_get');
  assert.equal(getTool.function.parameters.required[0], 'contactId');
  assert.equal(getTool.function.parameters.properties.contactId.type, 'string');
  console.log('ok - provider tool request schema exposes contact_profile_get with provider-safe name');
}

{
  const schema = buildProviderToolRequestSchema({
    debugUiRegistry: createRegistry({
      gate: { enabled: true, allowedTools: ['chat.emit_private'] },
      tools: [chatEmitPrivateTool],
    }),
    provider: 'openai',
    model: 'gpt-tool',
    sessionId: 's1',
  });

  assert.equal(schema.enabled, false);
  assert.equal(schema.diagnostics.reason, 'no allowed provider tools are registered');
  console.log('ok - provider tool request schema keeps chat_emit_private out of default model context');
}

{
  const schema = buildProviderToolRequestSchema({
    debugUiRegistry: createRegistry({
      gate: { enabled: true, allowedTools: ['chat.emit_private'] },
      tools: [chatEmitPrivateTool],
    }),
    provider: 'openai',
    model: 'gpt-tool',
    sessionId: 's1',
    allowedModelContextTools: CHAT_EMIT_PROVIDER_MODEL_CONTEXT_TOOLS,
  });

  assert.equal(schema.enabled, true);
  assert.deepEqual(schema.diagnostics.internalToolNames, ['chat.emit_private']);
  assert.deepEqual(schema.diagnostics.providerToolNames, ['chat_emit_private']);
  assert.equal(schema.diagnostics.writesChat, false);
  const emitTool = schema.requestOptions.tools[0];
  assert.equal(emitTool.function.name, 'chat_emit_private');
  assert.equal(emitTool.function.parameters.required.includes('targetName'), true);
  assert.equal(emitTool.function.parameters.required.includes('content'), true);
  console.log('ok - provider tool request schema exposes chat_emit_private as review-only tool');
}

{
  const schema = buildProviderToolRequestSchema({
    debugUiRegistry: createRegistry({
      gate: {
        enabled: true,
        allowedTools: ['memory.preview_actions', 'variable.preview_commands', 'worldbook.preview_actions'],
      },
      tools: [memoryPreviewTool, variablePreviewTool, worldbookPreviewTool],
    }),
    provider: 'openai',
    model: 'gpt-tool',
    sessionId: 's1',
  });

  assert.equal(schema.enabled, true);
  assert.deepEqual(schema.diagnostics.internalToolNames, [
    'memory.preview_actions',
    'variable.preview_commands',
    'worldbook.preview_actions',
  ]);
  assert.deepEqual(schema.diagnostics.providerToolNames, [
    'memory_preview_actions',
    'variable_preview_commands',
    'worldbook_preview_actions',
  ]);
  assert.equal(schema.diagnostics.writesChat, false);
  const previewToolNames = schema.requestOptions.tools.map(tool => tool.function.name);
  assert.deepEqual(previewToolNames, [
    'memory_preview_actions',
    'variable_preview_commands',
    'worldbook_preview_actions',
  ]);
  const memoryTool = schema.requestOptions.tools.find(tool => tool.function.name === 'memory_preview_actions');
  assert.equal(memoryTool.function.parameters.required.includes('sessionId'), true);
  assert.equal(memoryTool.function.parameters.required.includes('actions'), true);
  console.log('ok - provider tool request schema can expose write previews as review-only diff tools');
}

{
  const schema = buildProviderToolRequestSchema({
    debugUiRegistry: createRegistry({
      gate: { enabled: true, allowedTools: ['memory.preview_actions'] },
      tools: [memoryPreviewTool],
    }),
    provider: 'openai',
    model: 'gpt-tool',
    sessionId: 's1',
    allowedModelContextTools: DEFAULT_PROVIDER_BASE_MODEL_CONTEXT_TOOLS,
  });

  assert.equal(schema.enabled, false);
  assert.equal(schema.diagnostics.reason, 'no allowed provider tools are registered');
  console.log('ok - provider tool request schema keeps write previews behind explicit model-context policy');
}

{
  const schema = buildProviderToolRequestSchema({
    debugUiRegistry: createRegistry(),
    provider: 'anthropic',
    model: 'claude-tool',
    sessionId: 's1',
  });

  assert.equal(schema.enabled, true);
  assert.equal(schema.diagnostics.format, PROVIDER_TOOL_REQUEST_FORMATS.anthropic);
  assert.equal(schema.requestOptions.tools[0].name, 'contact_profile_list');
  assert.equal(schema.requestOptions.tools[0].input_schema.properties.limit.maximum, 1000);
  console.log('ok - provider tool request schema builds Anthropic tool schemas');
}

{
  const schema = buildProviderToolRequestSchema({
    debugUiRegistry: createRegistry(),
    provider: 'gemini',
    model: 'gemini-tool',
    sessionId: 's1',
  });

  const declaration = schema.requestOptions.tools[0].functionDeclarations[0];
  assert.equal(schema.enabled, true);
  assert.equal(schema.diagnostics.format, PROVIDER_TOOL_REQUEST_FORMATS.gemini);
  assert.equal(declaration.name, 'contact_profile_list');
  assert.equal(declaration.parameters.type, 'OBJECT');
  assert.equal(declaration.parameters.properties.limit.type, 'INTEGER');
  assert.equal(Object.hasOwn(declaration.parameters, 'additionalProperties'), false);
  console.log('ok - provider tool request schema builds Gemini function declarations');
}

{
  const schema = buildProviderToolRequestSchema({
    debugUiRegistry: createRegistry(),
    provider: 'openai',
    model: 'gpt-tool',
    sessionId: 's1',
    existingOptions: [{ tools: [{ type: 'function' }] }],
  });

  assert.equal(schema.enabled, false);
  assert.equal(schema.diagnostics.reason, 'request already contains provider tool options');
  console.log('ok - provider tool request schema does not merge over existing provider tool options');
}

{
  const normalized = normalizeProviderToolCall({
    id: 'call-1',
    name: 'contact_profile_list',
    arguments: { limit: 1 },
  });

  assert.equal(normalized.toolName, 'contact_profile.list');
  assert.equal(normalized.toolCallId, 'call-1');
  assert.deepEqual(normalized.arguments, { limit: 1 });
  console.log('ok - provider-safe tool names map back to internal agent tool names');
}

{
  const normalized = normalizeProviderToolCall({
    id: 'call-chat-1',
    name: 'chat_emit_private',
    arguments: { targetName: '菲伦', speakerName: '菲伦', content: '今晚别一个人走。' },
  });

  assert.equal(normalized.toolName, 'chat.emit_private');
  assert.equal(normalized.toolCallId, 'call-chat-1');
  assert.equal(normalized.arguments.targetName, '菲伦');
  console.log('ok - provider-safe chat_emit_private maps back to internal chat emit tool');
}

{
  const normalized = normalizeProviderToolCall({
    id: 'call-memory-preview-1',
    name: 'memory_preview_actions',
    arguments: { sessionId: 's1', actions: [] },
  });

  assert.equal(normalized.toolName, 'memory.preview_actions');
  assert.equal(normalized.toolCallId, 'call-memory-preview-1');
  assert.deepEqual(normalized.arguments, { sessionId: 's1', actions: [] });
  console.log('ok - provider-safe memory_preview_actions maps back to internal preview tool');
}

{
  const variable = normalizeProviderToolCall({
    id: 'call-variable-preview-1',
    name: 'variable_preview_commands',
    arguments: { sessionId: 's1', commands: [] },
  });
  const worldbook = normalizeProviderToolCall({
    id: 'call-worldbook-preview-1',
    name: 'worldbook_preview_actions',
    arguments: { worldId: 'world-1', actions: [] },
  });

  assert.equal(variable.toolName, 'variable.preview_commands');
  assert.equal(worldbook.toolName, 'worldbook.preview_actions');
  console.log('ok - provider-safe write preview aliases map back to internal preview tools');
}

{
  const accumulator = createProviderToolCallDeltaAccumulator({
    provider: 'openai',
    model: 'gpt-tool',
  });
  accumulator.push({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call-2',
          function: {
            name: 'contact_profile_list',
            arguments: '{"limit":1}',
          },
        }],
      },
    }],
  });
  const done = accumulator.push({
    choices: [{ finish_reason: 'tool_calls' }],
  });

  assert.equal(done.completed[0].toolName, 'contact_profile.list');
  assert.deepEqual(done.completed[0].arguments, { limit: 1 });
  console.log('ok - provider-safe streaming tool names complete as internal agent tool calls');
}

{
  const accumulator = createProviderToolCallDeltaAccumulator({
    provider: 'openai',
    model: 'gpt-tool',
  });
  accumulator.push({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call-get-1',
          function: {
            name: 'contact_profile_get',
            arguments: '{"contactId":"c1"}',
          },
        }],
      },
    }],
  });
  const done = accumulator.push({
    choices: [{ finish_reason: 'tool_calls' }],
  });

  assert.equal(done.completed[0].toolName, 'contact_profile.get');
  assert.deepEqual(done.completed[0].arguments, { contactId: 'c1' });
  console.log('ok - provider-safe contact_profile_get delta maps back to internal tool');
}

{
  const schema = buildProviderToolRequestSchema({
    debugUiRegistry: createRegistry(),
    provider: 'openai',
    model: 'gpt-tool',
    sessionId: 's1',
  });
  const provider = new OpenAIProvider({
    provider: 'openai',
    apiKey: 'test-key',
    model: 'gpt-tool',
  });
  const prepared = provider.prepareChatRequest([
    { role: 'user', content: 'hello' },
  ], schema.requestOptions);

  assert.equal(prepared.url, 'https://api.openai.com/v1/responses');
  assert.equal(prepared.payload.tools[0].name, 'contact_profile_list');
  assert.equal(prepared.payload.store, false);
  assert.equal(prepared.payload.tool_choice, 'auto');
  console.log('ok - OpenAI request preview uses the actual Responses tool payload');
}

{
  const schema = buildProviderToolRequestSchema({
    debugUiRegistry: createRegistry(),
    provider: 'gemini',
    model: 'gemini-tool',
    sessionId: 's1',
  });
  const messages = [{ role: 'user', content: 'hello' }];
  const geminiBody = new GeminiProvider({
    apiKey: 'test-key',
    model: 'gemini-tool',
  }).buildRequestBody(messages, schema.requestOptions);
  const makersuiteBody = new MakersuiteProvider({
    apiKey: 'test-key',
    model: 'gemini-tool',
  }).buildRequestBody(messages, schema.requestOptions);
  const vertexBody = new VertexAIProvider({
    apiKey: 'test-key',
    model: 'gemini-tool',
    vertexaiProjectId: 'test-project',
  }).buildRequestBody(messages, schema.requestOptions);

  assert.equal(geminiBody.tools[0].functionDeclarations[0].name, 'contact_profile_list');
  assert.equal(makersuiteBody.tools[0].functionDeclarations[0].name, 'contact_profile_list');
  assert.equal(vertexBody.tools[0].functionDeclarations[0].name, 'contact_profile_list');
  console.log('ok - Gemini-family providers preserve function declarations in request bodies');
}
