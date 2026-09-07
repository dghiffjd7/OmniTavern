import assert from 'node:assert/strict';
import { renderAgentRequestPreview } from '../../src/scripts/ui/chat/agent-request-preview.js';
const request = {
  messages: [
    { role: 'system', content: '<system>literal & "quoted"</system>' },
    { role: 'user', content: [{ type: 'text', text: 'input draft' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call1', type: 'function', function: { name: 'variable.preview_commands', arguments: '{"x":1}' } }] },
    { role: 'tool', content: 'result', tool_call_id: 'call1' },
  ],
  responsePrefix: '<prefix>', options: { temperature: .7, tools: [{ type: 'function', function: { name: 'test', description: '<img src=x>' } }] },
};
const before = structuredClone(request);
const html = renderAgentRequestPreview(request);
assert(html.includes('&lt;system&gt;literal &amp; &quot;quoted&quot;'));
assert(!html.includes('<img src=x>'));
assert(html.includes('input draft') && html.includes('base64'));
assert(html.includes('variable.preview_commands') && html.includes('tool_call_id: call1'));
assert(html.includes('&lt;prefix&gt;') && html.includes('temperature'));
assert.deepEqual(request, before);
assert(renderAgentRequestPreview(null).includes('hop-request-empty'));
console.log('ok - body preview escapes request content, preserves tools/media/prefill and leaves the request unchanged');
