import assert from 'node:assert/strict';
import {
  assembleLegacyTextRequest,
  assembleProviderFcRequest,
  createChatSemanticSnapshot,
  restoreDeferredLegacyTextMessages,
} from '../../src/scripts/ui/chat/chat-semantic-snapshot-utils.js';

const phoneLayer = 'MiPhone_start\n<聊天内容>旧文本合同</聊天内容>\nMiPhone_end';
const outputLayer = '请严格输出 msg_start / msg_end。';
const legacyMessages = [
  { role: 'system', content: '角色与世界观语义' },
  { role: 'system', content: phoneLayer, depth: 0 },
  { role: 'assistant', content: '历史回复' },
  { role: 'system', content: `仍需保留的业务规则\n\n${outputLayer}` },
  { role: 'user', content: '现在回复我' },
];

{
  const created = createChatSemanticSnapshot({
    requestId: 'req-1',
    turnId: 'turn-7',
    sessionId: 'session-a',
    surface: 'private_chat',
    responseTarget: 'assistant',
    legacyMessages,
    legacyLayers: [
      { id: 'phone_format', content: phoneLayer },
      { id: 'output_format', content: outputLayer },
    ],
    providerFcTransportMessage: '共享场景语义\n\n只调用 emit_private_reply。',
    target: { sessionId: 'session-a', speakerId: 'char-a' },
    capabilities: { basicToolCall: true, imageInputWithTools: false },
    budget: { inputTokens: 4096, trimmingPasses: 1 },
    revisions: { world: 8, memory: 3 },
  });

  assert.equal(created.ok, true);
  const { snapshot } = created;
  assert.equal(snapshot.version, 'chat.semantic.v1');
  assert.match(snapshot.fingerprint, /^chat-semantic-v1:[0-9a-f]{8}:[0-9]+$/u);
  assert.equal(snapshot.identity.requestId, 'req-1');
  assert.equal(snapshot.identity.turnId, 'turn-7');
  assert.equal(snapshot.identity.sessionId, 'session-a');
  assert.equal(snapshot.messageAnchors.length, 2);
  assert.deepEqual(snapshot.messageAnchors.map(anchor => anchor.id), ['phone_format', 'output_format']);
  assert.deepEqual(snapshot.messageAnchors.map(anchor => anchor.role), ['system', 'system']);
  assert.deepEqual(snapshot.messageAnchors.map(anchor => anchor.insertionDepth), [0, 0]);
  assert.deepEqual(snapshot.semanticMessages, [
    { role: 'system', content: '角色与世界观语义' },
    { role: 'assistant', content: '历史回复' },
    { role: 'system', content: '仍需保留的业务规则' },
    { role: 'user', content: '现在回复我' },
  ]);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.semanticMessages), true);
  assert.equal(Object.isFrozen(snapshot.budget), true);
  assert.throws(() => {
    snapshot.semanticMessages.push({ role: 'user', content: 'mutate' });
  }, TypeError);

  const fc = assembleProviderFcRequest(snapshot);
  const legacy = assembleLegacyTextRequest(snapshot);
  assert.equal(fc.ok, true);
  assert.equal(legacy.ok, true);
  assert.equal(fc.snapshotFingerprint, snapshot.fingerprint);
  assert.equal(legacy.snapshotFingerprint, snapshot.fingerprint);
  assert.deepEqual(legacy.messages, legacyMessages);
  assert.deepEqual(fc.messages, [
    { role: 'system', content: '角色与世界观语义' },
    { role: 'assistant', content: '历史回复' },
    { role: 'system', content: '仍需保留的业务规则' },
    { role: 'system', content: '共享场景语义\n\n只调用 emit_private_reply。' },
    { role: 'user', content: '现在回复我' },
  ]);
  assert.equal(fc.messages.some(message => String(message?.content || '').includes('MiPhone_start')), false);
  assert.equal(fc.messages.some(message => String(message?.content || '').includes('msg_start')), false);
  assert.equal(snapshot.budget.trimmingPasses, 1);
  console.log('ok - one immutable semantic snapshot assembles FC and exact legacy requests');
}

{
  const created = createChatSemanticSnapshot({
    legacyMessages: [
      { role: 'system', content: phoneLayer },
      { role: 'system', content: `${phoneLayer}\n\nduplicate` },
      { role: 'user', content: 'reply' },
    ],
    legacyLayers: [{ id: 'phone_format', content: phoneLayer }],
    providerFcTransportMessage: 'Use the tool.',
  });
  assert.equal(created.ok, false);
  assert.equal(created.reason, 'legacy_transport_layer_mismatch');
  assert.equal(created.diagnostics.layerMatches.phone_format, 2);
  console.log('ok - duplicate or missing legacy layers fail closed before transport assembly');
}

{
  const created = createChatSemanticSnapshot({
    legacyMessages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看看这张图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
        ],
      },
    ],
    legacyLayers: [],
    providerFcTransportMessage: 'Use the tool.',
  });
  assert.equal(created.ok, true);
  const fc = assembleProviderFcRequest(created.snapshot);
  assert.deepEqual(fc.messages[1], created.snapshot.semanticMessages[0]);
  assert.equal(fc.messages[1].content[1].type, 'image_url');
  console.log('ok - semantic snapshot preserves multimodal content parts without text coercion');
}

{
  const marker = '\uE000chat-semantic:req-direct:phone_format\uE001';
  const created = createChatSemanticSnapshot({
    legacyMessages: [
      { role: 'system', content: '角色语义' },
      { role: 'system', content: marker },
      { role: 'user', content: '直接走 FC' },
    ],
    legacyLayers: [{ id: 'phone_format', content: phoneLayer, marker }],
    providerFcTransportMessage: 'Use the tool.',
  });
  assert.equal(created.ok, true, created.reason);
  assert.equal(created.snapshot.semanticMessages.some(message => (
    String(message?.content || '').includes('chat-semantic:')
  )), false);
  assert.deepEqual(assembleLegacyTextRequest(created.snapshot).messages, [
    { role: 'system', content: '角色语义' },
    { role: 'system', content: phoneLayer },
    { role: 'user', content: '直接走 FC' },
  ]);
  assert.equal(created.snapshot.messageAnchors[0].name, 'legacy:phone_format');
  console.log('ok - deferred named anchors assemble FC without constructing legacy prompt messages');
}

{
  const marker = '\uE000chat-semantic:req-restore:output_format\uE001';
  const restored = restoreDeferredLegacyTextMessages({
    messages: [{ role: 'system', content: `before\n\n${marker}` }],
    deferredLegacyLayers: [{ id: 'output_format', content: outputLayer, marker }],
  });
  assert.equal(restored.ok, true, restored.reason);
  assert.deepEqual(restored.messages, [{ role: 'system', content: `before\n\n${outputLayer}` }]);
  assert.equal(restored.replacements.output_format, 1);
  console.log('ok - fail-closed FC planning can restore deferred layers without rebuilding semantics');
}

{
  // 回归：聊天模式带图片时，末尾的格式层标记被并进最后一条用户消息，而它是「文字 + 图片」数组
  const marker = 'chat-semantic:req-image:output_format';
  const imagePart = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
  const messages = [
    { role: 'system', content: '角色语义' },
    { role: 'user', content: [{ type: 'text', text: '哲: [图片]' }, imagePart, { type: 'text', text: marker }] },
  ];
  const restored = restoreDeferredLegacyTextMessages({
    messages,
    deferredLegacyLayers: [{ id: 'output_format', content: outputLayer, marker }],
  });
  assert.equal(restored.ok, true, restored.reason);
  assert.equal(restored.replacements.output_format, 1);
  assert.deepEqual(restored.messages[1].content, [{ type: 'text', text: '哲: [图片]' }, imagePart, { type: 'text', text: outputLayer }]);
  assert.equal(messages[1].content[2].text, marker, 'input messages are not mutated');
  console.log('ok - deferred layers inside multimodal user content are restored');
}
