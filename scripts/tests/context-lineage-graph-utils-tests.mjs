import assert from 'node:assert/strict';

import {
  LINEAGE_EDGE_STATUS,
  LINEAGE_EDGE_TYPES,
  buildContextLineageGraphFromRequest,
  buildPromptTraceFromRequest,
  formatPromptTraceText,
} from '../../src/scripts/ui/chat/context-lineage-graph-utils.js';

{
  const request = {
    at: 1760000000000,
    requestId: 'req-1',
    provider: 'openai',
    model: 'test-model',
    session: { id: 'contact:alice', name: 'Alice', isGroup: false },
    presetContext: { uiMode: 'chat' },
    messages: [{ role: 'user', content: 'hello' }],
    worldDebug: {
      injectedEntries: [
        {
          worldId: 'world:global',
          entryId: 'entry:1',
          blockId: 'legacy',
          title: '全局条目',
          sourceKind: 'global',
          role: 'system',
          contentPreview: 'preview text',
        },
      ],
      trimmedEntries: [
        {
          worldId: 'world:session',
          entryId: 'entry:2',
          blockId: 'b2',
          title: '裁剪条目',
          sourceKind: 'session',
          trimReason: 'moment_session_budget',
        },
      ],
      dynamicWorld: {
        enabled: true,
        candidates: [
          { sessionId: 'contact:alice', name: 'Alice', type: 'contact', reasons: ['mention'], worldIds: ['world:session'] },
          { sessionId: 'contact:bob', name: 'Bob', type: 'contact', reasons: ['exact_name'], worldIds: [] },
        ],
        selectedSources: [
          { sessionId: 'contact:alice', name: 'Alice', type: 'contact', reasons: ['mention'], worldIds: ['world:session'] },
        ],
        sessionBudgetTokens: 100,
        sessionUsedTokens: 20,
        sessionTrimmedCount: 1,
      },
      dynamicProfiles: {
        enabled: true,
        promptInjected: true,
        threshold: 2,
        candidates: [
          {
            contactId: 'contact:alice',
            name: 'Alice',
            score: 5,
            status: 'active',
            reasons: ['keyword_match', 'memory_row_match'],
            matchedTerms: ['拍照'],
            matchedRows: [
              { id: 'row:1', tableId: 'events', tableName: '重要事件', rowSummary: 'Alice 和用户约过拍照', score: 1, matchedTerms: ['拍照'] },
            ],
          },
          {
            contactId: 'contact:bob',
            name: 'Bob',
            score: 0,
            status: 'blocked',
            blockedReason: 'threshold_block',
            matchedRows: [],
          },
        ],
        selectedSources: [
          {
            contactId: 'contact:alice',
            name: 'Alice',
            score: 5,
            status: 'active',
            reasons: ['keyword_match', 'memory_row_match'],
            matchedTerms: ['拍照'],
            matchedRows: [
              { id: 'row:1', tableId: 'events', tableName: '重要事件', rowSummary: 'Alice 和用户约过拍照', score: 1, matchedTerms: ['拍照'] },
            ],
          },
        ],
        injectedRows: [
          {
            contactId: 'contact:alice',
            contactName: 'Alice',
            row: { id: 'row:1', tableId: 'events', tableName: '重要事件', rowSummary: 'Alice 和用户约过拍照' },
          },
        ],
      },
    },
  };
  const graph = buildContextLineageGraphFromRequest(request, { scopeId: 'persona:1' });
  assert.equal(graph.scopeId, 'persona:1');
  assert.equal(graph.rootId, 'prompt:req-1');
  assert.ok(graph.nodes.some(node => node.id === 'prompt:req-1' && node.type === 'prompt'));
  assert.ok(graph.nodes.some(node => node.id === 'source:contact:alice' && node.type === 'contact'));
  assert.ok(graph.nodes.some(node => node.id === 'worldbook_entry:world:global:entry:1:legacy'));
  assert.ok(graph.edges.some(edge =>
    edge.type === LINEAGE_EDGE_TYPES.INJECTS &&
    edge.status === LINEAGE_EDGE_STATUS.ACTIVE &&
    edge.target === 'prompt:req-1'
  ));
  assert.ok(graph.edges.some(edge =>
    edge.type === LINEAGE_EDGE_TYPES.TRIMMED_BY &&
    edge.status === LINEAGE_EDGE_STATUS.TRIMMED &&
    edge.reason === 'budget_limit'
  ));
  assert.ok(graph.edges.some(edge =>
    edge.source === 'source:contact:alice' &&
    edge.target === 'worldbook:world:session' &&
    edge.type === LINEAGE_EDGE_TYPES.BINDS
  ));
  assert.ok(graph.nodes.some(node => node.id === 'contact_profile:contact:alice' && node.type === 'contact_profile'));
  assert.ok(graph.nodes.some(node => node.id === 'memory_row:row:1' && node.type === 'memory_row'));
  assert.ok(graph.edges.some(edge =>
    edge.source === 'memory_row:row:1' &&
    edge.target === 'prompt:req-1' &&
    edge.type === LINEAGE_EDGE_TYPES.INJECTS
  ));
  console.log('ok - buildContextLineageGraphFromRequest maps world debug and dynamic sources into lineage graph');
}

{
  const trace = buildPromptTraceFromRequest({
    at: 1760000000001,
    requestId: 'req-2',
    session: { id: 'group:g1', name: '群聊', isGroup: true },
    presetContext: { uiMode: 'chat' },
    messages: [{ role: 'user', content: 'hi' }],
    worldDebug: {
      builtinEntries: [],
      globalEntries: [],
      roleEntries: [],
      sessionEntries: [],
      injectedEntries: [],
      templateEntries: [],
      trimmedEntries: [],
      budgetTokens: 200,
      usedTokens: 50,
    },
  }, { scopeId: 'persona:2', traceId: 'trace-2' });
  assert.equal(trace.traceId, 'trace-2');
  assert.equal(trace.scopeId, 'persona:2');
  assert.equal(trace.sessionId, 'group:g1');
  assert.equal(trace.spans.length, 2);
  const text = formatPromptTraceText(trace);
  assert.match(text, /\[PromptTrace\]/);
  assert.match(text, /\[上下文血缘图\]/);
  assert.match(text, /resolveWorldbook/);
  console.log('ok - buildPromptTraceFromRequest creates trace text with lineage graph summary');
}

{
  // 程序生成的节点名跟随界面语言；世界书名这类用户内容保持原样
  const { initializeI18n } = await import('../../src/scripts/i18n/index.js');
  try {
    await initializeI18n({
      preference: 'en',
      documentLike: null,
      fetchFn: async () => ({ ok: true, json: async () => ({ '本次 Prompt': 'This Prompt', 角色: 'Character', '{value}世界书 {value2}': '{value} lorebook {value2}' }) }),
    });
    const graph = buildContextLineageGraphFromRequest({
      at: 1760000000000,
      requestId: 'req-en',
      session: { id: 'rp:fog', name: 'Fog', isGroup: false },
      presetContext: { uiMode: 'rp' },
      messages: [{ role: 'user', content: 'hi' }],
      worldDebug: { injectedEntries: [{ worldId: '雾港来信', entryId: 'e1', title: 'Fog Harbor', sourceKind: 'role', contentPreview: 'x' }] },
    });
    const labels = graph.nodes.map(node => node.label);
    assert.equal(labels.includes('This Prompt'), true, labels.join(' | '));
    assert.equal(labels.includes('Character lorebook 雾港来信'), true, labels.join(' | '));
    assert.equal(labels.includes('Fog Harbor'), true);
  } finally {
    await initializeI18n({ preference: 'zh-CN', documentLike: null });
  }
  console.log('ok - generated lineage node labels follow the UI language');
}
