import assert from 'node:assert/strict';

import {
  MAID_CONTEXT_MEMORY_TOKEN_LIMIT,
  MAID_CONTEXT_COMPACTION_TURN_THRESHOLD,
  MAID_COMPACTION_PROTECTION_TTL_MS,
  MAID_CONTEXT_TOTAL_TOKEN_LIMIT,
  MAID_CONTEXT_VERSION,
  MAID_EXTRACTION_MAX_AUTO_ATTEMPTS,
  MAID_EXTRACTION_RETRY_DELAYS_MS,
  MaidConversationStore,
  MAID_CONVERSATION_LEGACY_ARCHIVE_KEY,
  MAID_CONVERSATION_STORE_KEY,
  formatMaidHistoryContextText,
  formatMaidMemoryTableText,
  normalizeMaidConversationState,
} from '../../src/scripts/storage/maid-conversation-store.js';
import {
  MaidSemanticMemoryStore,
} from '../../src/scripts/storage/maid-semantic-memory-store.js';

// 清历史时已经排队、但尚未写入的结构化/模型提取结果都必须失效。
for (const mode of ['structured', 'extracted']) {
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  const persistGate = deferred(), persistEntered = deferred(), extractionQueued = deferred();
  let saveCount = 0, extractorCalls = 0;
  const semantic = new MaidSemanticMemoryStore({ storage: null, loadKv: async () => null,
    saveKv: async () => { if (++saveCount === 1) { persistEntered.resolve(); await persistGate.promise; } },
  });
  await semantic.load();
  const seed = semantic.upsertMemory({ kind: 'important_event', key: 'event.offline_seed', content: 'Existing memory holds the persistence queue.' });
  await persistEntered.promise;
  const originalUpsert = semantic.upsertMemory.bind(semantic);
  semantic.upsertMemory = (...args) => { const operation = originalUpsert(...args); extractionQueued.resolve(); return operation; };
  const memory = { kind: 'preference', key: 'presentation.default', content: 'Preference extracted from old history.', sourceTurnIds: ['old-turn'] };
  const conversation = new MaidConversationStore({ storage: null,
    loadKv: async key => key === MAID_CONVERSATION_STORE_KEY ? {
      turns: [{ id: 'old-turn', input: 'Old preference.', message: 'Acknowledged', status: 'succeeded', at: Date.now(), structuredMemories: mode === 'structured' ? [memory] : [] }],
      extractionBatches: [{ id: 'batch', sourceTurnIds: ['old-turn'], status: 'pending', deterministicComplete: mode === 'extracted' }],
    } : null,
    saveKv: async () => {}, semanticMemoryStore: semantic,
    extractSemanticMemories: async () => { extractorCalls++; return { memories: [memory], candidateKeys: ['presentation.default'] }; },
    logger: { warn() {}, debug() {} },
  });
  await conversation.load();
  const processing = conversation.processPendingExtractions();
  await extractionQueued.promise;
  await conversation.clearHistory();
  persistGate.resolve();
  await Promise.all([seed, processing]);
  assert.equal(conversation.exportState().turns.length, 0);
  assert.equal(conversation.exportState().extractionBatches.length, 0);
  assert.equal(semantic.listMemories().some(item => item.sourceTurnIds.includes('old-turn')), false, `${mode}: invalidated writes cannot return after clearing history`);
  assert.equal(semantic.listMemories().length, 1, 'previously committed long-term memories are retained');
  if (mode === 'structured') assert.equal(extractorCalls, 0, 'clearing during the deterministic write also prevents a subsequent extraction request');
}
console.log('ok - clearing history invalidates extraction writes already queued in the semantic store');

const createStorage = () => {
  const data = new Map();
  return {
    getItem: key => data.get(key) || null,
    setItem: (key, value) => data.set(key, String(value)),
    data,
  };
};

{
  const state = normalizeMaidConversationState({
    turns: [
      { id: 't1', input: '创建角色卡 A', toolName: 'persona.create', message: '已完成' },
    ],
    memoryRows: [
      { id: 'm1', title: '摘要', content: '用户创建了角色卡 A。' },
    ],
  }, { now: () => 1000 });
  assert.equal(state.version, 1);
  assert.equal(state.turns.length, 1);
  assert.equal(state.memoryRows.length, 1);
  assert.equal(state.memoryRows[0].tokenCount > 0, true);
  console.log('ok - maid conversation state normalizes turns and memory rows');
}

{
  const historyText = formatMaidHistoryContextText({
    turns: [
      { id: 't1', at: 1000, input: '创建角色卡 A', toolName: 'persona.create', featureId: 'persona.create', status: 'succeeded', message: '已完成' },
      {
        id: 't2',
        at: 2000,
        input: '继续刚才那个',
        status: 'interrupted',
        continuable: true,
        reactStoppedReason: 'max_steps_reached',
        continueHint: '下一步建议工具：worldbook.update_entries',
        message: '已达到本轮执行预算。',
      },
    ],
  });
  assert.match(historyText, /创建角色卡 A/);
  assert.match(historyText, /继续刚才那个/);
  assert.match(historyText, /可继续: 是/);
  assert.match(historyText, /下一步建议工具/);

  const memoryText = formatMaidMemoryTableText({
    rows: [
      { title: '摘要', content: '用户创建了角色卡 A。', tags: ['角色卡'] },
    ],
  });
  assert.match(memoryText, /摘要/);
  assert.match(memoryText, /角色卡/);
  console.log('ok - maid conversation formatters render history and memory table text');
}

{
  const storage = createStorage();
  const saved = [];
  const store = new MaidConversationStore({
    storage,
    saveKv: async (key, value) => saved.push({ key, value }),
    loadKv: async () => null,
    now: () => 1000,
    compactionTurnThreshold: MAID_CONTEXT_COMPACTION_TURN_THRESHOLD,
    compactionHistoryTokenThreshold: 100000,
  });
  await store.load();
  for (let index = 0; index < MAID_CONTEXT_COMPACTION_TURN_THRESHOLD; index += 1) {
    await store.appendTurn({
      id: `clock-turn-${index + 1}`,
      input: `新增轮次 ${index + 1}`,
      status: 'succeeded',
      message: '已完成',
    });
  }
  assert.equal(store.exportState().memoryRows.length, 0, '达到但未超过 turn 门槛时不压缩');
  await store.recordContextInjection(200000);
  assert.equal(store.exportState().memoryRows.length, 0, '重复注入不得推动压缩时钟');
  await store.appendTurn({
    id: 'clock-turn-13',
    input: '新增轮次 13',
    status: 'succeeded',
    message: '已完成',
  });
  const after = store.exportState();
  assert.equal(after.memoryRows.length, 1);
  assert.match(after.memoryRows[0].content, /新增轮次 1/);
  assert.equal(after.turns.filter(turn => turn.compacted).length, 5);
  assert.equal(after.turns.filter(turn => !turn.compacted).length, 8);
  assert.equal(after.pendingInjectedTokens, 0);
  assert.equal(
    store.getLegacyArchive().compactedTurns.some(turn => turn.id === 'clock-turn-1'),
    true,
    '压缩前必须先把旧 turn 写入审计归档',
  );
  assert.equal(saved.length > 0, true);
  console.log('ok - maid conversation store compacts on appendTurn clock, not repeated context injection');
}

{
  const store = new MaidConversationStore({
    storage: createStorage(),
    loadKv: async () => null,
    saveKv: async () => true,
    now: () => 1500,
    compactionTurnThreshold: 100,
    compactionHistoryTokenThreshold: 80,
  });
  await store.load();
  for (let index = 0; index < 9; index += 1) {
    await store.appendTurn({
      id: `token-turn-${index + 1}`,
      input: `很长的新增历史 ${index + 1} ${'需要压缩的内容'.repeat(30)}`,
      status: 'succeeded',
      message: '已完成',
    });
  }
  const state = store.exportState();
  assert.equal(state.turns.filter(turn => turn.compacted).length, 1);
  assert.equal(state.turns.filter(turn => !turn.compacted).length, 8);
  console.log('ok - maid conversation appendTurn clock also compacts on uncompressed history tokens');
}

{
  let clock = 1750;
  const store = new MaidConversationStore({
    storage: createStorage(),
    loadKv: async () => null,
    saveKv: async () => true,
    now: () => clock,
    compactionTurnThreshold: 12,
    compactionHistoryTokenThreshold: 100000,
  });
  await store.load();
  await store.appendTurn({
    id: 'protected-first',
    input: '尚未完成的批量任务',
    status: 'interrupted',
    continuable: true,
    message: '稍后继续',
  });
  clock += 1;
  await store.appendTurn({
    id: 'protected-latest',
    input: '继续刚才的批量任务',
    status: 'interrupted',
    continuable: true,
    message: '仍可继续',
  });
  let state = store.exportState();
  assert.equal(state.turns.find(turn => turn.id === 'protected-first')?.compactionProtection, '');
  assert.equal(
    state.turns.find(turn => turn.id === 'protected-first')?.compactionProtectionReleaseReason,
    'superseded_by_next_turn',
  );
  assert.equal(state.turns.find(turn => turn.id === 'protected-latest')?.compactionProtection, 'continuable');

  clock += 1;
  await store.appendTurn({
    id: 'protected-completed',
    input: '继续完成刚才的批量任务',
    status: 'succeeded',
    message: '已完成',
  });
  state = store.exportState();
  assert.equal(state.turns.find(turn => turn.id === 'protected-latest')?.compactionProtection, '');
  assert.equal(
    state.turns.find(turn => turn.id === 'protected-latest')?.compactionProtectionReleaseReason,
    'completed_by_next_turn',
  );

  for (let index = 1; index < 13; index += 1) {
    clock += 1;
    await store.appendTurn({
      id: `protected-clock-${index}`,
      input: `普通轮次 ${index}`,
      status: 'succeeded',
      message: '已完成',
    });
  }
  state = store.exportState();
  assert.equal(
    state.turns.some(turn => turn.compactionProtection),
    false,
  );
  assert.equal(
    state.memoryRows.some(row => row.sourceTurnIds.includes('protected-first')),
    true,
  );
  console.log('ok - only the latest recoverable turn stays protected and completion releases it');
}

{
  const at = 20_000;
  const state = normalizeMaidConversationState({
    turns: [{
      id: 'expired-protection',
      at,
      input: '一周前未完成的任务',
      continuable: true,
      compactionProtection: 'continuable',
    }],
  }, {
    now: () => at + MAID_COMPACTION_PROTECTION_TTL_MS + 1,
  });
  assert.equal(state.turns[0].compactionProtection, '');
  assert.equal(state.turns[0].compactionProtectionReleaseReason, 'expired');
  console.log('ok - stale compaction protection expires without erasing audit fields');
}

{
  const semanticUpserts = [];
  let extractionShouldFail = true;
  let clock = 1900;
  const semanticMemoryStore = {
    scopeId: 'maid_default',
    listMemories: () => [],
    upsertMemory: async (memory, options) => {
      semanticUpserts.push({ memory, options });
      return { ok: true, action: 'created', memory };
    },
  };
  const store = new MaidConversationStore({
    storage: createStorage(),
    loadKv: async () => null,
    saveKv: async () => true,
    now: () => clock,
    compactionTurnThreshold: 8,
    compactionHistoryTokenThreshold: 100000,
    semanticMemoryStore,
    extractSemanticMemories: async () => {
      if (extractionShouldFail) {
        const error = new Error('temporary provider failure');
        error.memoryExtractionUsage = [{
          status: 'recorded',
          provider: 'pioneer',
          model: 'memory-custom',
          promptTokens: 90,
          completionTokens: 10,
          totalTokens: 100,
          latencyMs: 20,
          modelCallCount: 1,
          degraded: false,
          source: 'custom',
        }];
        throw error;
      }
      return {
        memories: [],
        candidateKeys: [],
        fallbackUsed: true,
        modelSource: 'maid_main_fallback',
        model: 'maid-main',
        usageEntries: [{
          status: 'recorded',
          provider: 'deepseek',
          model: 'maid-main',
          promptTokens: 80,
          completionTokens: 20,
          totalTokens: 100,
          latencyMs: 25,
          modelCallCount: 1,
          degraded: true,
          source: 'maid_main_fallback',
        }],
      };
    },
  });
  await store.load();
  for (let index = 0; index < 9; index += 1) {
    await store.appendTurn({
      id: `extract-turn-${index + 1}`,
      input: `提取轮次 ${index + 1}`,
      status: 'succeeded',
      message: '已完成',
      structuredMemories: index === 0 ? [{
        kind: 'preference',
        key: 'presentation.default',
        content: '普通操作默认后台执行。',
        confidence: 'explicit',
      }] : [],
    });
  }
  await store.flushPendingExtractions();
  let state = store.exportState();
  assert.equal(state.memoryRows.length, 1, '模型提取失败不能阻塞归档压缩');
  assert.equal(state.extractionBatches[0].status, 'pending');
  assert.equal(state.extractionBatches[0].attempts, 1);
  assert.equal(
    state.extractionBatches[0].nextRetryAt,
    clock + MAID_EXTRACTION_RETRY_DELAYS_MS[0],
  );
  assert.equal(
    semanticUpserts.some(call => call.memory.key === 'presentation.default'),
    true,
    '确定性投影不依赖模型提取成功',
  );

  extractionShouldFail = false;
  clock = state.extractionBatches[0].nextRetryAt;
  await store.processPendingExtractions();
  await store.flushPendingExtractions();
  state = store.exportState();
  assert.equal(state.extractionBatches.every(batch => batch.status === 'completed'), true);
  assert.equal(state.extractionBatches[0].extractedCount, 0, '0 条自然语言事实是合法成功结果');
  assert.equal(state.extractionBatches[0].modelSource, 'maid_main_fallback');
  assert.equal(state.extractionBatches[0].model, 'maid-main');
  assert.equal(state.extractionBatches[0].fallbackUsed, true);
  assert.deepEqual(
    state.extractionBatches[0].modelUsage.map(entry => [entry.provider, entry.model, entry.totalTokens]),
    [
      ['pioneer', 'memory-custom', 100],
      ['deepseek', 'maid-main', 100],
    ],
  );
  console.log('ok - semantic extraction is best-effort, retryable, and allows zero extracted facts');
}

{
  let clock = 30_000;
  let calls = 0;
  const semanticMemoryStore = {
    scopeId: 'maid_default',
    listMemories: () => [],
    upsertMemory: async memory => ({ ok: true, memory }),
  };
  const store = new MaidConversationStore({
    storage: createStorage(),
    loadKv: async () => null,
    saveKv: async () => true,
    now: () => clock,
    compactionTurnThreshold: 1,
    compactionHistoryTokenThreshold: 100000,
    semanticMemoryStore,
    extractSemanticMemories: async () => {
      calls += 1;
      throw new Error('invalid JSON');
    },
  });
  await store.load();
  for (let index = 1; index <= 9; index += 1) {
    await store.appendTurn({
      id: `bounded-${index}`,
      input: `第 ${index} 轮`,
      status: 'succeeded',
      message: '完成',
    });
  }
  await store.flushPendingExtractions();

  let batch = store.exportState().extractionBatches[0];
  while (batch.status === 'pending') {
    clock = batch.nextRetryAt;
    await store.processPendingExtractions();
    batch = store.exportState().extractionBatches[0];
  }
  assert.equal(calls, MAID_EXTRACTION_MAX_AUTO_ATTEMPTS);
  assert.equal(batch.status, 'paused');
  assert.equal(batch.attempts, MAID_EXTRACTION_MAX_AUTO_ATTEMPTS);
  assert.equal(batch.pauseReason, 'auto_retry_exhausted');

  clock += 24 * 60 * 60 * 1000;
  await store.processPendingExtractions();
  assert.equal(calls, MAID_EXTRACTION_MAX_AUTO_ATTEMPTS, 'paused batch must not spend again automatically');
  console.log('ok - failed semantic extraction uses bounded backoff and pauses after the auto retry budget');
}

{
  const store = new MaidConversationStore({
    storage: createStorage(),
    loadKv: async () => null,
    saveKv: async () => true,
    now: () => 2000,
  });
  await store.load();
  await store.appendTurn({ input: '你好', message: '我在' });
  const snapshot = store.getContextSnapshot();
  assert.equal(snapshot.turnCount, 1);
  assert.match(snapshot.historyText, /你好/);
  assert.equal(snapshot.memoryText, '');
  assert.equal(snapshot.tokenCount > 0, true);
  console.log('ok - maid conversation store exposes context snapshots');
}

{
  const storage = createStorage();
  let clock = 20_000;
  const semanticStore = new MaidSemanticMemoryStore({
    storage,
    loadKv: async () => null,
    saveKv: async () => true,
    now: () => ++clock,
  });
  await semanticStore.load();
  const semanticFact = await semanticStore.upsertMemory({
    kind: 'decision',
    key: 'content.worldbook_style',
    content: '精灵世界书的人物条目统一使用第三人称，并保留雾港规则原句。',
    tags: ['精灵', '雾港', '世界书'],
    confidence: 'explicit',
    sourceTurnIds: ['cross-window-source'],
  });
  const store = new MaidConversationStore({
    storage,
    loadKv: async () => null,
    saveKv: async () => true,
    now: () => ++clock,
    semanticMemoryStore: semanticStore,
    compactionTurnThreshold: 12,
    compactionHistoryTokenThreshold: 100000,
  });
  await store.load();
  await store.appendTurn({
    id: 'cross-window-source',
    input: '请记住精灵世界书的雾港规则原句。',
    status: 'succeeded',
    message: '已记住。',
  });
  for (let index = 0; index < 12; index += 1) {
    await store.appendTurn({
      id: `cross-window-noise-${index + 1}`,
      input: `无关的后续轮次 ${index + 1}`,
      status: 'succeeded',
      message: '已完成。',
    });
  }
  const snapshot = await store.getContextSnapshotAsync({
    query: '继续精灵世界书的雾港规则',
  });
  assert.doesNotMatch(snapshot.historyText, /雾港规则原句/, '原句应已跨出近期窗口');
  assert.match(snapshot.semanticMemoryText, /精灵世界书的人物条目统一使用第三人称/);
  assert.match(snapshot.semanticMemoryText, /；记于: \d{4}-\d{2}-\d{2}/, 'memory lines carry the date they were recorded');
  assert.match(snapshot.memoryText, /\[长期记忆\]/);
  assert.equal(snapshot.selectedSemanticMemoryIds.includes(semanticFact.memory.id), true);
  assert.equal(semanticStore.getMemory(semanticFact.memory.id).lastUsedAt > 0, true);
  console.log('ok - cross-window facts return through semantic memory instead of recent history');
}

{
  const storage = createStorage();
  let clock = 30_000;
  const semanticStore = new MaidSemanticMemoryStore({
    storage,
    loadKv: async () => null,
    saveKv: async () => true,
    now: () => ++clock,
  });
  await semanticStore.load();
  const resourceFact = await semanticStore.upsertMemory({
    kind: 'resource_state',
    content: '世界书「已删除测试书」存在。',
    tags: ['世界书'],
    confidence: 'verified',
    resourceRef: { type: 'worldbook', id: '已删除测试书' },
    sourceTurnIds: ['resource-source'],
  });
  const store = new MaidConversationStore({
    storage,
    loadKv: async () => null,
    saveKv: async () => true,
    now: () => ++clock,
    semanticMemoryStore: semanticStore,
  });
  await store.load();
  const snapshot = await store.getContextSnapshotAsync({
    query: '查看已删除测试书',
    validateResource: async () => ({ status: 'not_found' }),
  });
  assert.doesNotMatch(snapshot.memoryText, /已删除测试书存在/);
  assert.equal(semanticStore.getMemory(resourceFact.memory.id).status, 'stale');
  assert.deepEqual(snapshot.contextDiagnostics.semantic.staleIds, [resourceFact.memory.id]);
  console.log('ok - selected resource memories are lazily validated before injection');
}

{
  const storage = createStorage();
  storage.setItem(MAID_CONVERSATION_STORE_KEY, JSON.stringify({
    version: 1,
    updatedAt: 40_000,
    turns: [
      {
        id: 'near-window-original',
        at: 40_001,
        input: '前一步是继续修订晨雾港的第三章。',
        message: '第三章修订尚未完成。',
        continuable: true,
        compactionProtection: 'continuable',
      },
    ],
    memoryRows: [
      {
        id: 'legacy-morning-port',
        at: 39_000,
        title: '晨雾港旧决定',
        content: '晨雾港的钟楼条目必须保留潮汐时间。',
        tags: ['晨雾港', '世界书'],
        kind: 'legacy_episode',
      },
    ],
  }));
  const store = new MaidConversationStore({
    storage,
    loadKv: async () => null,
    saveKv: async () => true,
    now: () => 40_100,
  });
  await store.load();
  const snapshot = await store.getContextSnapshotAsync({
    query: '继续前一步，并沿用晨雾港钟楼决定',
    maxTotalTokens: 800,
  });
  assert.match(snapshot.historyText, /前一步是继续修订晨雾港的第三章/);
  assert.match(snapshot.workingMemoryText, /第三章修订尚未完成/);
  assert.match(snapshot.legacyMemoryText, /\[legacy\]/);
  assert.match(snapshot.memoryText, /\[旧轮次归档 · legacy\]/);
  assert.equal(snapshot.selectedLegacyMemoryIds.includes('legacy-morning-port'), true);
  assert.equal(snapshot.tokenCount <= 800, true);
  console.log('ok - near-window original text and bounded legacy fallback stay in separate layers');
}

{
  const { formatMaidMemoryTableText } = await import('../../src/scripts/storage/maid-conversation-store.js');
  const text = formatMaidMemoryTableText({
    rows: [
      { title: '用户偏好', content: '喜欢简洁回复\n避免长篇解释', tags: ['偏好'] },
      { title: '任务进度', content: '世界书清理完成' },
    ],
  });
  const lines = text.split('\n');
  assert.equal(lines.length, 2, '每条记忆一行');
  assert.equal(lines[0], '- 标题: 用户偏好；内容: 喜欢简洁回复 / 避免长篇解释；标签: 偏好');
  assert.equal(lines[1], '- 标题: 任务进度；内容: 世界书清理完成');
  console.log('ok - 女仆记忆表格排列对齐聊天室记忆格式（标签: 值；分号分隔）');
}

{
  const storage = createStorage();
  const memoryRows = Array.from({ length: 20 }, (_, index) => ({
    id: `memory-${index + 1}`,
    at: index + 1,
    title: index === 2 ? '精灵资料' : `旧摘要 ${index + 1}`,
    content: index === 2
      ? `精灵世界书的重要决定 ${'相关资料'.repeat(2400)}`
      : `普通历史记录 ${index + 1} ${'无关内容'.repeat(2400)}`,
    tags: index === 2 ? ['精灵', '世界书'] : ['旧摘要'],
  }));
  storage.setItem(MAID_CONVERSATION_STORE_KEY, JSON.stringify({
    version: 1,
    updatedAt: 1000,
    turns: Array.from({ length: 12 }, (_, index) => ({
      id: `turn-${index + 1}`,
      at: index + 1,
      input: `第 ${index + 1} 轮`,
      message: '正常完成',
    })),
    memoryRows,
  }));
  const store = new MaidConversationStore({
    storage,
    loadKv: async () => null,
    saveKv: async () => true,
    now: () => 2000,
  });
  await store.load();
  const snapshot = store.getContextSnapshot({ query: '继续精灵世界书的决定' });
  assert.equal(snapshot.maidContextVersion, MAID_CONTEXT_VERSION);
  assert.equal(snapshot.memoryTokenCount <= MAID_CONTEXT_MEMORY_TOKEN_LIMIT, true);
  assert.equal(snapshot.tokenCount <= MAID_CONTEXT_TOTAL_TOKEN_LIMIT, true);
  assert.equal(snapshot.selectedMemoryIds.length <= 12, true);
  assert.equal(snapshot.selectedMemoryIds.includes('memory-3'), true, '旧但相关的记忆必须进入 Top-K');
  assert.equal(snapshot.memoryText.split('\n').every(line => line.startsWith('- 标题: ')), true);
  assert.equal(
    snapshot.contextDiagnostics.memory.some(item => item.reason === 'per_row_token_limit'),
    true,
    '超长单行必须按行投影，不能独占整个记忆预算',
  );
  console.log('ok - maid context snapshot enforces total/memory budgets and recalls relevant legacy rows');
}

{
  const storage = createStorage();
  const kv = new Map();
  const rawRows = Array.from({ length: 241 }, (_, index) => ({
    id: `legacy-memory-${index + 1}`,
    title: `旧摘要 ${index + 1}`,
    content: `旧内容 ${index + 1}`,
  }));
  storage.setItem(MAID_CONVERSATION_STORE_KEY, JSON.stringify({
    version: 1,
    updatedAt: 3000,
    threadId: 'maid_default',
    turns: [{ id: 'legacy-turn-1', input: '旧请求', message: '旧结果' }],
    memoryRows: rawRows,
  }));
  const store = new MaidConversationStore({
    storage,
    loadKv: async key => kv.get(key) || null,
    saveKv: async (key, value) => {
      kv.set(key, JSON.parse(JSON.stringify(value)));
      return true;
    },
    now: () => 4000,
  });
  await store.load();
  assert.equal(store.exportState().memoryRows.length, 240, '主 store 仍维持既有限额');
  assert.equal(store.getLegacyArchive().baseline.memoryRows.length, 241, '归档必须发生在 normalize/slice 之前');
  assert.equal(kv.get(MAID_CONVERSATION_LEGACY_ARCHIVE_KEY).baseline.memoryRows.length, 241);
  const localArchive = JSON.parse(storage.getItem(MAID_CONVERSATION_LEGACY_ARCHIVE_KEY));
  assert.equal(Object.hasOwn(localArchive, 'baseline'), false, 'KV 成功后本地归档不得重复保存大 baseline');
  assert.equal(localArchive.baselineCaptured, true);
  assert.equal(localArchive.baselineStorage, 'kv');
  await store.load();
  assert.equal(store.getLegacyArchive().baseline.memoryRows.length, 241, '重复 load 不得重建或重复快照');
  console.log('ok - maid legacy archive snapshots the authoritative raw store once before truncation');
}

{
  const storage = createStorage();
  const now = Date.UTC(2026, 6, 29);
  const oldAt = now - (91 * 24 * 60 * 60 * 1000);
  const recentRows = Array.from({ length: 140 }, (_, index) => ({
    id: `bounded-memory-${index + 1}`,
    at: now - ((140 - index) * 1000),
    title: `增量归档 ${index + 1}`,
    content: `归档正文 ${index + 1} ${'很长的审计内容'.repeat(1000)}`,
  }));
  storage.setItem(MAID_CONVERSATION_STORE_KEY, JSON.stringify({
    version: 1,
    updatedAt: now,
    threadId: 'maid_default',
    turns: [],
    memoryRows: [],
  }));
  storage.setItem(MAID_CONVERSATION_LEGACY_ARCHIVE_KEY, JSON.stringify({
    version: 1,
    createdAt: oldAt,
    updatedAt: now - 1,
    threadId: 'maid_default',
    baseline: { turns: [], memoryRows: [] },
    evictedTurns: [{ id: 'expired-turn', at: oldAt, input: '过期请求', message: '过期结果' }],
    compactedTurns: [],
    evictedMemoryRows: recentRows,
  }));
  const store = new MaidConversationStore({
    storage,
    loadKv: async () => null,
    saveKv: async () => true,
    now: () => now,
  });
  await store.load();
  const archive = store.getLegacyArchive();
  assert.equal(
    archive.evictedTurns.some(turn => turn.id === 'expired-turn'),
    false,
    '超过 TTL 的增量归档必须裁切',
  );
  assert.equal(archive.evictedMemoryRows.length <= 120, true, '增量记忆行必须有条数上限');
  const incrementalBytes = JSON.stringify({
    evictedTurns: archive.evictedTurns,
    compactedTurns: archive.compactedTurns,
    evictedMemoryRows: archive.evictedMemoryRows,
  }).length * 2;
  assert.equal(incrementalBytes <= 1024 * 1024, true, '增量归档必须受 1 MiB 本地字节预算约束');
  console.log('ok - maid legacy incremental archive enforces TTL, count, and byte budgets');
}

{
  const storage = createStorage();
  const store = new MaidConversationStore({
    storage,
    loadKv: async () => null,
    saveKv: async () => true,
    now: () => 5000,
  });
  await store.load();
  for (let index = 0; index < 121; index += 1) {
    await store.appendTurn({
      id: `future-turn-${index + 1}`,
      at: 5000 + index,
      input: `未来请求 ${index + 1}`,
      message: `未来结果 ${index + 1}`,
    });
  }
  const archive = store.getLegacyArchive();
  assert.equal(store.exportState().turns.length, 120);
  assert.equal(
    [...archive.compactedTurns, ...archive.evictedTurns].some(turn => turn.id === 'future-turn-1'),
    true,
    '快照之后才产生并被压缩或淘汰的 turn 也必须进入增量归档',
  );
  console.log('ok - maid legacy archive keeps post-migration evictions instead of silently dropping them');
}

{
  const storage = createStorage();
  const semanticStore = new MaidSemanticMemoryStore({
    storage,
    loadKv: async () => null,
    saveKv: async () => true,
    now: () => 6000,
  });
  await semanticStore.load();
  await semanticStore.upsertMemory({
    kind: 'decision',
    key: 'workflow.nonblocking_usage',
    content: '记忆使用时间异步落盘。',
    confidence: 'explicit',
  });
  let releaseUsageWrite;
  const blockedUsageWrite = new Promise(resolve => {
    releaseUsageWrite = resolve;
  });
  semanticStore.markMemoriesUsed = () => blockedUsageWrite;
  const store = new MaidConversationStore({
    storage,
    loadKv: async () => null,
    saveKv: async () => true,
    now: () => 6001,
    semanticMemoryStore: semanticStore,
  });
  await store.load();
  const snapshotPromise = store.getContextSnapshotAsync({
    query: '继续记忆使用时间异步落盘',
  });
  const raced = await Promise.race([
    snapshotPromise.then(() => 'resolved'),
    new Promise(resolve => setTimeout(() => resolve('blocked'), 30)),
  ]);
  releaseUsageWrite();
  await snapshotPromise;
  assert.equal(raced, 'resolved', 'markMemoriesUsed 持久化不得阻塞 Run 上下文生成');
  console.log('ok - semantic memory usage persistence stays off the Run startup critical path');
}

{
  const buildBatch = (index, status) => ({
    id: `trim-batch-${index}`,
    sourceTurnIds: [`turn-${index}`],
    status,
    createdAt: 1000 + index,
    updatedAt: 1000 + index,
  });
  const mixed = [
    ...Array.from({ length: 65 }, (_, i) => buildBatch(i + 1, 'completed')),
    ...Array.from({ length: 5 }, (_, i) => buildBatch(100 + i, 'pending')),
  ];
  const mixedState = normalizeMaidConversationState({ extractionBatches: mixed });
  assert.equal(mixedState.extractionBatches.length, 60, '批次总量仍受 60 上限约束');
  assert.equal(
    mixedState.extractionBatches.filter(batch => batch.status === 'pending').length,
    5,
    'pending 批次不得被已完成批次挤出（先驱逐 completed 最旧）',
  );
  assert.equal(
    mixedState.extractionBatches.some(batch => batch.id === 'trim-batch-1'),
    false,
    '被驱逐的应是最旧的 completed 批次',
  );

  const allPending = Array.from({ length: 70 }, (_, i) => buildBatch(i + 1, 'pending'));
  const pendingState = normalizeMaidConversationState({ extractionBatches: allPending });
  assert.equal(pendingState.extractionBatches.length, 60, '全 pending 超限时仍有界');
  assert.equal(
    pendingState.extractionBatches[0].id,
    'trim-batch-11',
    '全 pending 超限时丢最旧、保最新',
  );
  console.log('ok - extraction batch trim evicts completed batches before pending ones');
}

{
  let clock = 9000;
  const storage = createStorage();
  const semanticStore = new MaidSemanticMemoryStore({
    storage,
    loadKv: async () => null,
    saveKv: async () => true,
    now: () => ++clock,
  });
  await semanticStore.load();
  const fact = await semanticStore.upsertMemory({
    kind: 'decision',
    key: 'content.section_budget_probe',
    content: '预算探针决定：这一条内容足够长，用来验证被裁掉的区块不得再报告任何选中记忆编号。',
    confidence: 'explicit',
    sourceTurnIds: ['budget-probe-source'],
  });
  const store = new MaidConversationStore({
    storage,
    loadKv: async () => null,
    saveKv: async () => true,
    now: () => ++clock,
    semanticMemoryStore: semanticStore,
  });
  await store.load();
  await store.appendTurn({
    id: 'budget-probe-source',
    input: '记住预算探针决定。',
    status: 'succeeded',
    message: '已记住。',
  });
  for (const budget of [1, 4, 8, 12, 16, 24, 40, 400]) {
    const snapshot = await store.getContextSnapshotAsync({
      query: '预算探针决定',
      maxMemoryTokens: budget,
    });
    if (!/\[长期记忆\]/.test(snapshot.memoryText)) {
      assert.equal(
        snapshot.selectedSemanticMemoryIds.includes(fact.memory.id),
        false,
        `预算 ${budget} 下长期记忆区块未注入，却报告了其选中记忆 ID`,
      );
    }
  }
  console.log('ok - dropped memory sections never report selected memory IDs');
}

{
  // 清除最近对话连同待提取批次；进行中的提取结果不再写回；轮次归档可单独清除
  const upserts = [];
  let releaseExtraction = null;
  const kv = new Map();
  const store = new MaidConversationStore({
    storage: createStorage(),
    loadKv: async key => kv.get(key) || null,
    saveKv: async (key, value) => { kv.set(key, JSON.parse(JSON.stringify(value))); return true; },
    now: (() => { let clock = 50_000; return () => ++clock; })(),
    compactionTurnThreshold: 8,
    compactionHistoryTokenThreshold: 100000,
    semanticMemoryStore: {
      scopeId: 'maid_default',
      listMemories: () => [],
      upsertMemory: async (memory) => { upserts.push(memory); return { ok: true, action: 'created', memory }; },
    },
    extractSemanticMemories: () => new Promise((resolve) => {
      releaseExtraction = () => resolve({ memories: [{ kind: 'preference', key: 'presentation.default', content: '来自已清除对话的记忆', sourceTurnIds: ['clear-turn-1'] }], candidateKeys: ['presentation.default'] });
    }),
    logger: { warn() {}, debug() {} },
  });
  await store.load();
  for (let index = 0; index < 9; index += 1) {
    await store.appendTurn({ id: `clear-turn-${index + 1}`, input: `测试轮次 ${index + 1}`, status: 'succeeded', message: '已完成' });
  }
  assert.ok(store.exportState().memoryRows.length > 0, 'compaction produced an archive row');
  assert.ok(store.exportState().extractionBatches.length > 0);
  while (!releaseExtraction) await new Promise(resolve => setTimeout(resolve, 5));
  const cleared = await store.clearHistory();
  assert.ok(cleared.turns > 0);
  releaseExtraction();
  await store.flushPendingExtractions();
  assert.equal(upserts.length, 0, 'an extraction that finishes after clearing writes nothing back');
  assert.equal(store.exportState().turns.length, 0);
  assert.equal(store.exportState().extractionBatches.length, 0);
  assert.match(store.getHistoryContextText(), /尚未记录/);
  assert.equal(kv.get(MAID_CONVERSATION_STORE_KEY).turns.length, 0, 'persisted');
  assert.ok(store.exportState().memoryRows.length > 0, 'clearing history keeps the archive rows');
  assert.ok(await store.clearMemoryRows() > 0);
  assert.equal(store.exportState().memoryRows.length, 0);
  assert.match(store.getMemoryTableDisplayText(), /尚未生成/);
  console.log('ok - maid history and archive rows can be cleared without late extraction write-back');
}
