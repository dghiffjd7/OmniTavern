import assert from 'node:assert/strict';

import {
  MAID_SEMANTIC_MEMORY_MAX_RECORDS,
  MaidSemanticMemoryStore,
  buildMaidResourceStateKey,
  getMaidSemanticMemoryStorageKey,
  validateMaidSemanticMemoryKey,
} from '../../src/scripts/storage/maid-semantic-memory-store.js';

const createStorage = () => {
  const data = new Map();
  return {
    getItem: key => data.get(key) || null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
    data,
  };
};

const createStore = async ({
  scopeId = 'maid_default',
  storage = createStorage(),
  now = (() => {
    let value = 1000;
    return () => ++value;
  })(),
} = {}) => {
  const kv = new Map();
  const store = new MaidSemanticMemoryStore({
    scopeId,
    storage,
    loadKv: async key => kv.get(key) || null,
    saveKv: async (key, value) => {
      kv.set(key, JSON.parse(JSON.stringify(value)));
      return true;
    },
    now,
  });
  await store.load();
  return { store, storage, kv };
};

{
  assert.equal(validateMaidSemanticMemoryKey('presentation.default', { kind: 'preference' }).ok, true);
  assert.equal(validateMaidSemanticMemoryKey('用户喜欢简短回复', { kind: 'preference' }).ok, false);
  assert.equal(validateMaidSemanticMemoryKey('anything.default', { kind: 'preference' }).ok, false);
  assert.equal(
    buildMaidResourceStateKey('worldbook', '精灵抱抱'),
    buildMaidResourceStateKey('worldbook', '精灵抱抱'),
    '结构化资源 key 必须确定性生成',
  );
  console.log('ok - semantic memory keys reject free text and generate deterministic resource keys');
}

{
  const { store } = await createStore();
  const created = await store.upsertMemory({
    kind: 'preference',
    key: 'presentation.default',
    content: '普通操作默认后台执行。',
    confidence: 'explicit',
    sourceTurnIds: ['turn-1'],
  });
  assert.equal(created.ok, true);
  assert.equal(created.action, 'created');

  const weaker = await store.upsertMemory({
    kind: 'preference',
    key: 'presentation.default',
    content: '普通操作默认打开页面。',
    confidence: 'inferred',
    sourceTurnIds: ['turn-2'],
  });
  assert.equal(weaker.action, 'ignored_weaker');
  assert.equal(weaker.memory.content, '普通操作默认后台执行。');
  assert.deepEqual(weaker.memory.sourceTurnIds, ['turn-1', 'turn-2']);

  const repeatedByInference = await store.upsertMemory({
    kind: 'preference',
    key: 'presentation.default',
    content: '普通操作默认后台执行。',
    confidence: 'inferred',
    status: 'resolved',
    sourceTurnIds: ['turn-2-repeat'],
  });
  assert.equal(repeatedByInference.action, 'updated');
  assert.equal(repeatedByInference.memory.confidence, 'explicit', '同内容弱写入不得降级 confidence');
  assert.equal(repeatedByInference.memory.status, 'active', '同内容弱写入不得翻转既有 status');
  assert.deepEqual(
    repeatedByInference.memory.sourceTurnIds,
    ['turn-1', 'turn-2', 'turn-2-repeat'],
  );

  const replaced = await store.upsertMemory({
    kind: 'preference',
    key: 'presentation.default',
    content: '普通操作默认后台执行，明确要求查看时再打开。',
    confidence: 'explicit',
    sourceTurnIds: ['turn-3'],
  });
  assert.equal(replaced.action, 'updated');
  assert.equal(store.listMemories().length, 1, '同 scope/kind/key 必须 upsert 而非追加');
  assert.match(replaced.memory.content, /明确要求查看/);
  console.log('ok - semantic memory upsert preserves explicit facts against weaker inference');
}

{
  const { store } = await createStore({ scopeId: 'owner-a' });
  const result = await store.upsertMemory({
    scopeId: 'owner-b',
    kind: 'decision',
    key: 'workflow.default',
    content: '先预览再执行。',
    confidence: 'explicit',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'scope_mismatch');
  assert.equal(store.listMemories().length, 0);
  console.log('ok - semantic memory store rejects cross-owner writes');
}

{
  const { store } = await createStore();
  const first = await store.upsertMemory({
    kind: 'preference',
    key: 'response.default',
    content: '回复尽量简洁清楚，不要重复解释。',
    confidence: 'verified',
    sourceTurnIds: ['turn-1'],
  });
  const duplicate = await store.upsertMemory({
    kind: 'preference',
    key: 'response.concise',
    content: '回复应尽量简洁清楚，不要反复解释。',
    confidence: 'inferred',
    sourceTurnIds: ['turn-2'],
  });
  assert.equal(first.action, 'created');
  assert.equal(duplicate.action, 'merged_duplicate');
  assert.equal(store.listMemories().length, 1);
  assert.deepEqual(store.listMemories()[0].sourceTurnIds, ['turn-1', 'turn-2']);

  await store.upsertMemory({
    kind: 'decision',
    key: 'presentation.default',
    content: '结果默认不打开页面。',
    confidence: 'explicit',
    sourceTurnIds: ['turn-3'],
  });
  const conflicting = await store.upsertMemory({
    kind: 'decision',
    key: 'presentation.primary',
    content: '结果默认打开页面。',
    confidence: 'explicit',
    sourceTurnIds: ['turn-4'],
  });
  assert.equal(conflicting.action, 'created', '不同 key 的 explicit 决定不得被近重复兜底吞并');
  assert.equal(store.listMemories({ kind: 'decision' }).length, 2);
  console.log('ok - near-duplicate merge stays inside kind/key family and preserves explicit conflicts');
}

{
  const { store } = await createStore();
  const presentation = await store.upsertMemory({
    kind: 'preference',
    key: 'presentation.default',
    content: '普通资源操作默认在后台完成，只有明确要求查看时才打开主要结果。',
    confidence: 'explicit',
    sourceTurnIds: ['turn-presentation'],
  });
  const pollutedConfirmation = await store.upsertMemory({
    kind: 'preference',
    key: 'workflow.confirmation',
    content: '普通资源操作默认在后台完成。',
    confidence: 'explicit',
    sourceTurnIds: ['turn-repeat'],
  });
  assert.equal(presentation.action, 'created');
  assert.equal(pollutedConfirmation.action, 'merged_duplicate');
  assert.equal(store.listMemories().length, 1);
  assert.equal(store.listMemories()[0].key, 'presentation.default');
  assert.match(store.listMemories()[0].content, /明确要求查看/);
  assert.deepEqual(
    store.listMemories()[0].sourceTurnIds,
    ['turn-presentation', 'turn-repeat'],
  );

  const actualConfirmation = await store.upsertMemory({
    kind: 'preference',
    key: 'workflow.confirmation',
    content: '删除资源前必须先显示确认列表。',
    confidence: 'explicit',
    sourceTurnIds: ['turn-confirmation'],
  });
  assert.equal(actualConfirmation.action, 'created', '真正的执行确认偏好不得被呈现偏好吞并');
  assert.equal(store.listMemories().length, 2);
  console.log('ok - known cross-key containment merges extraction drift without hiding real confirmation rules');
}

{
  const { store } = await createStore();
  const resourceKey = buildMaidResourceStateKey('worldbook', '精灵抱抱');
  const created = await store.upsertMemory({
    kind: 'resource_state',
    key: resourceKey,
    content: '世界书「精灵抱抱」存在，共 12 条。',
    confidence: 'verified',
    resourceRef: { type: 'worldbook', id: '精灵抱抱' },
    sourceTurnIds: ['turn-resource'],
  });
  assert.equal(created.ok, true);

  let checks = 0;
  const unavailable = await store.validateResourcesForInjection(
    [created.memory, created.memory],
    {
      cache: new Map(),
      validateResource: async () => {
        checks += 1;
        throw new Error('reader unavailable');
      },
    },
  );
  assert.equal(checks, 1, '同一 Run 的相同资源只校验一次');
  assert.equal(unavailable.memories.length, 2);
  assert.equal(unavailable.unverifiedIds.includes(created.memory.id), true);
  assert.equal(store.getMemory(created.memory.id).status, 'active', '读取异常不得误标 stale');

  const missing = await store.validateResourcesForInjection(
    [created.memory],
    {
      validateResource: async () => ({ status: 'not_found' }),
    },
  );
  assert.equal(missing.memories.length, 0);
  assert.deepEqual(missing.staleIds, [created.memory.id]);
  assert.equal(store.getMemory(created.memory.id).status, 'stale');
  console.log('ok - lazy resource validation distinguishes missing from temporarily unavailable');
}

{
  const storage = createStorage();
  const first = await createStore({ scopeId: 'owner-a', storage });
  await first.store.upsertMemory({
    kind: 'task_state',
    key: 'task.worldbook_cleanup',
    content: '世界书清理等待用户确认。',
    confidence: 'verified',
    status: 'active',
    sourceTurnIds: ['turn-task'],
  });
  const second = await createStore({ scopeId: 'owner-a', storage });
  assert.equal(second.store.listMemories().length, 1);
  await second.store.setScope('owner-b');
  assert.equal(second.store.listMemories().length, 0, '不同 owner scope 必须使用独立持久化状态');
  console.log('ok - semantic memory persists locally and isolates owner scopes');
}

{
  let clock = 10_000;
  const { store } = await createStore({ now: () => ++clock });
  const oldRelevant = await store.upsertMemory({
    kind: 'decision',
    key: 'content.worldbook_style',
    content: '精灵世界书的人物条目统一使用第三人称，并保留雾港规则。',
    tags: ['精灵', '雾港', '世界书'],
    confidence: 'explicit',
    sourceTurnIds: ['turn-old-fact'],
  });
  for (let index = 0; index < 6; index += 1) {
    await store.upsertMemory({
      kind: 'important_event',
      key: `event.recent_${index + 1}`,
      content: `最近但无关的事件 ${index + 1}，唯一代号 recent-${index + 1}。`,
      tags: ['无关'],
      confidence: 'explicit',
      sourceTurnIds: [`turn-recent-${index + 1}`],
    });
  }
  const stale = await store.upsertMemory({
    kind: 'resource_state',
    content: '精灵世界书旧副本已经存在。',
    tags: ['精灵', '世界书'],
    confidence: 'verified',
    status: 'stale',
    resourceRef: { type: 'worldbook', id: '精灵旧副本' },
    sourceTurnIds: ['turn-stale'],
  });
  assert.equal(stale.ok, true);

  const retrieval = store.retrieveMemories({
    query: '继续精灵世界书的雾港规则',
  });
  assert.equal(retrieval.memories.length <= 12, true);
  assert.equal(
    retrieval.memories.some(memory => memory.id === oldRelevant.memory.id),
    true,
    '跨出最新集合的旧事实必须凭关键词/tag 进入相关 Top-K',
  );
  assert.equal(
    retrieval.memories.some(memory => memory.id === stale.memory.id),
    false,
    'stale/resolved/archived 不得参与注入候选',
  );
  assert.equal(
    retrieval.matches.find(match => match.id === oldRelevant.memory.id)?.reasons.includes('tag_match'),
    true,
    '检索原因必须可解释',
  );
  assert.equal(retrieval.latestIds.length, 4);
  assert.equal(retrieval.relevantIds.length <= 8, true);

  const noQuery = store.retrieveMemories({ query: '' });
  assert.equal(noQuery.memories.length, 4, '无查询时只取最新少量，不伪造相关命中');
  console.log('ok - semantic retrieval combines latest and explainable local relevance');
}

{
  const storage = createStorage();
  const scopeId = 'maid_default';
  const key = getMaidSemanticMemoryStorageKey(scopeId);
  const memories = Array.from({ length: MAID_SEMANTIC_MEMORY_MAX_RECORDS }, (_, index) => ({
    id: `capacity-${index + 1}`,
    scopeId,
    kind: 'important_event',
    key: `event.capacity_${index + 1}`,
    content: `容量记录 ${index + 1}`,
    confidence: 'verified',
    status: index === 0 ? 'stale' : 'active',
    createdAt: 1000 + index,
    updatedAt: 1000 + index,
  }));
  storage.setItem(key, JSON.stringify({
    version: 1,
    scopeId,
    updatedAt: 3000,
    memories,
  }));
  const { store } = await createStore({ scopeId, storage, now: () => 5000 });
  const created = await store.upsertMemory({
    kind: 'important_event',
    key: 'event.capacity_new',
    content: '容量已满后仍应接纳的新事实。',
    confidence: 'explicit',
  });
  assert.equal(created.ok, true);
  assert.equal(created.action, 'created');
  assert.equal(store.listMemories().length, MAID_SEMANTIC_MEMORY_MAX_RECORDS);
  assert.equal(store.getMemory('capacity-1'), null, '容量满时应先驱逐最旧的非 active 记录');
  assert.equal(
    store.listMemories().some(memory => memory.key === 'event.capacity_new'),
    true,
  );
  console.log('ok - semantic memory capacity evicts stale history before rejecting new facts');
}

{
  // 设置面板的记忆管理：手动改写视为明确表述，之后较弱的推断不能覆盖；清空只清当前范围
  const { store, kv } = await createStore();
  const created = await store.upsertMemory({ kind: 'preference', key: 'presentation.default', content: '默认打开界面。', confidence: 'inferred' });
  const edited = await store.updateMemoryContent(created.memory.id, '  默认后台执行，不要打开界面。  ');
  assert.equal(edited.content, '默认后台执行，不要打开界面。');
  assert.equal(edited.confidence, 'explicit');
  assert.equal(await store.updateMemoryContent(created.memory.id, '   '), null, 'empty content is rejected');
  assert.equal(await store.updateMemoryContent('missing', '内容'), null);
  const weaker = await store.upsertMemory({ kind: 'preference', key: 'presentation.default', content: '默认打开界面。', confidence: 'inferred' });
  assert.equal(weaker.action, 'ignored_weaker', 'a later model guess cannot overwrite the user edit');
  assert.equal(store.getMemory(created.memory.id).content, '默认后台执行，不要打开界面。');
  await store.upsertMemory({ kind: 'important_event', key: 'event.test', content: '测试事件。', confidence: 'verified' });
  assert.equal(await store.clearMemories(), 2);
  assert.equal(store.listMemories().length, 0);
  assert.equal([...kv.values()][0].memories.length, 0, 'the cleared state is persisted');
  assert.equal(await store.clearMemories(), 0);
  console.log('ok - semantic memories can be edited and cleared from settings');
}

console.log('maid-semantic-memory-store-tests passed');
