import assert from 'node:assert/strict';

import {
  createMaidFormatProfileStore,
  normalizeMaidFormatProfileState,
} from '../../src/scripts/storage/maid-format-profile-store.js';
import {
  MAID_FORMAT_PROFILE_EXTRACTOR_VERSION,
  MAID_FORMAT_PROFILE_SCHEMA_VERSION,
  buildMaidFormatProfileSourceState,
  extractSafeRegexFormatEvidence,
} from '../../src/scripts/storage/maid-format-profile-evidence-utils.js';
import { createMaidFormatProfileSourceStateResolver } from '../../src/scripts/ui/chat/format-profile-source-runtime-utils.js';

const createFakeStorage = () => {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
  };
};

{
  const storage = createFakeStorage();
  const store = createMaidFormatProfileStore({ storage, now: () => 1000 });
  const saved = store.set('蒂法', {
    guide: '每条回复末尾必须有 <status>好感度:N</status> 状态块',
    sources: [{ type: 'worldbook', ref: '蒂法' }, { type: 'regex', ref: 'status 渲染' }],
  });
  assert.equal(saved.sessionId, '蒂法');
  assert.equal(saved.sources.length, 2);

  const reloaded = createMaidFormatProfileStore({ storage, now: () => 2000 });
  const profile = reloaded.get('蒂法');
  assert.match(profile.guide, /status/);
  assert.equal(profile.sources[0].type, 'worldbook');
  console.log('ok - 画像保存并跨实例持久化');
}

{
  const storage = createFakeStorage();
  const store = createMaidFormatProfileStore({ storage, now: () => 1000 });
  assert.equal(store.set('会话A', { guide: '' }), null, '空规范不保存');
  assert.equal(store.set('', { guide: '有内容' }), null, '空会话不保存');
  assert.equal(store.get('不存在'), null);
  assert.equal(store.remove('不存在'), false);
  store.set('会话A', { guide: '规范内容规范内容' });
  assert.equal(store.remove('会话A'), true);
  assert.equal(store.get('会话A'), null);
  console.log('ok - 非法输入拒绝与删除');
}

{
  const state = normalizeMaidFormatProfileState({
    profiles: {
      a: { guide: 'x'.repeat(9000), updatedAt: 5 },
      b: { guide: '正常规范内容', sources: [{ type: 'regex', ref: 'r1' }], updatedAt: 9 },
      c: { guide: '', updatedAt: 3 },
    },
  }, { now: () => 100 });
  assert.equal(state.profiles.a.guide.length, 6000, '超长规范截断');
  assert.equal(state.profiles.c, undefined, '空规范条目被清理');
  assert.equal(state.profiles.b.sources.length, 1);
  console.log('ok - 归一化截断与清理');
}

{
  // localStorage 配额满（setItem 抛异常）时 kv 通道仍保证持久化。
  const kvStore = new Map();
  const quotaFullStorage = {
    getItem: () => null,
    setItem: () => { throw new Error('quota exceeded'); },
    removeItem: () => {},
  };
  const { createMaidFormatProfileStore } = await import('../../src/scripts/storage/maid-format-profile-store.js');
  const store = createMaidFormatProfileStore({
    storage: quotaFullStorage,
    loadKv: async key => kvStore.get(key) || null,
    saveKv: async (key, data) => { kvStore.set(key, data); },
    now: () => 1000,
    logger: { warn() {}, debug() {} },
  });
  await store.hydrate();
  const saved = store.set('蒂法', { guide: 'status 块格式规范内容' });
  assert.ok(saved, 'localStorage 满时保存仍应成功（kv 通道）');
  await new Promise(r => setTimeout(r, 0));
  assert.ok(kvStore.has('maid_format_profile_store_v1'), 'kv 应已写入');

  const reloaded = createMaidFormatProfileStore({
    storage: quotaFullStorage,
    loadKv: async key => kvStore.get(key) || null,
    saveKv: async () => {},
    now: () => 2000,
    logger: { warn() {}, debug() {} },
  });
  await reloaded.hydrate();
  assert.match(reloaded.get('蒂法')?.guide || '', /status/, 'kv hydrate 应恢复画像');
  console.log('ok - localStorage 配额满时经 kv 通道持久化与恢复');
}

{
  const positive = extractSafeRegexFormatEvidence([
    {
      id: 'status-format',
      scriptName: '状态块格式转换',
      findRegex: '/^<status>([\\s\\S]*?)<\\/status>$/g',
      replaceString: '状态块：$1',
      placement: [2],
      disabled: false,
    },
  ]);
  assert.equal(positive.evidence.length, 1, '明确的 AI 输出成对标签可作为结构证据');
  assert.deepEqual(positive.evidence[0].markers, ['<status>...</status>']);
  assert.equal(Object.hasOwn(positive.evidence[0], 'findRegex'), false, '证据不得携带原始正则');
  assert.equal(Object.hasOwn(positive.evidence[0], 'replaceString'), false, '证据不得携带原始 replacement');

  const cleanupCorpus = extractSafeRegexFormatEvidence([
    {
      id: 'remove-think',
      scriptName: '清理思考块',
      findRegex: '/<think>[\\s\\S]*?<\\/think>/g',
      replaceString: '',
      placement: [2],
    },
    {
      id: 'strip-status',
      scriptName: '隐藏状态标签',
      findRegex: '/<status>([\\s\\S]*?)<\\/status>/g',
      replaceString: '$1',
      placement: [2],
    },
    {
      id: 'display-card',
      scriptName: '状态栏美化',
      findRegex: '/<status>([\\s\\S]*?)<\\/status>/g',
      replaceString: '<div class="status">$1</div>',
      placement: [2],
      markdownOnly: true,
    },
    {
      id: 'input-only',
      scriptName: '输入替换',
      findRegex: '/<status>([\\s\\S]*?)<\\/status>/g',
      replaceString: '状态块：$1',
      placement: [1],
    },
    {
      id: 'negative-filter',
      scriptName: '格式过滤',
      findRegex: '/^(?!<status>)[\\s\\S]*$/g',
      replaceString: '状态块：$&',
      placement: [2],
    },
  ]);
  assert.equal(cleanupCorpus.evidence.length, 0, '纯显示/清理/负向/非 AI 输出正则不得推断必需格式');
  console.log('ok - 正则格式证据只接受高置信结构，清理语料零误判');
}

{
  const sourceA = buildMaidFormatProfileSourceState({
    presets: [{ type: 'sysprompt', id: 'p1', value: { format_rules: 'A' } }],
    regexRules: [],
    worldbooks: [{ id: 'w1', updatedAt: 10, entriesCount: 3 }],
    persona: { id: 'u1', revision: 4 },
    character: { id: 'c1', revision: 7 },
  });
  const sourceASame = buildMaidFormatProfileSourceState({
    character: { revision: 7, id: 'c1' },
    persona: { revision: 4, id: 'u1' },
    worldbooks: [{ entriesCount: 3, updatedAt: 10, id: 'w1' }],
    regexRules: [],
    presets: [{ value: { format_rules: 'A' }, id: 'p1', type: 'sysprompt' }],
  });
  const sourceB = buildMaidFormatProfileSourceState({
    presets: [{ type: 'sysprompt', id: 'p1', value: { format_rules: 'B' } }],
    regexRules: [],
    worldbooks: [{ id: 'w1', updatedAt: 10, entriesCount: 3 }],
    persona: { id: 'u1', revision: 4 },
    character: { id: 'c1', revision: 7 },
  });
  assert.equal(sourceA.fingerprint, sourceASame.fingerprint, '对象键序不影响来源指纹');
  assert.notEqual(sourceA.fingerprint, sourceB.fingerprint, '来源正文变化必须改变指纹');

  const storage = createFakeStorage();
  const store = createMaidFormatProfileStore({ storage, now: () => 1000 });
  store.set('会话A', {
    guide: '<status>...</status>',
    sourceFingerprint: sourceA.fingerprint,
    evidence: sourceA.evidence,
    confidence: 'high',
  });
  assert.equal(store.get('会话A', sourceA)?.usable, true);
  const stale = store.get('会话A', sourceB);
  assert.equal(stale.stale, true);
  assert.equal(stale.sourceChanged, true);
  assert.equal(stale.usable, false, '自动画像来源变化后不得继续注入 Guardian');

  store.set('会话B', {
    guide: '<status>...</status>',
    sourceFingerprint: sourceA.fingerprint,
    manualOverride: true,
  });
  const manual = store.get('会话B', sourceB);
  assert.equal(manual.usable, true, '用户手动画像在来源变化后保留');
  assert.equal(manual.sourceChanged, true, '手动画像仍须明确标记来源变化');
  assert.equal(manual.schemaVersion, MAID_FORMAT_PROFILE_SCHEMA_VERSION);
  assert.equal(manual.extractorVersion, MAID_FORMAT_PROFILE_EXTRACTOR_VERSION);
  console.log('ok - 来源指纹变化使自动画像失效，手动覆盖保留并显式标记');
}

{
  let presetRule = 'A';
  let worldRevision = 10;
  const resolver = createMaidFormatProfileSourceStateResolver({
    presetStore: {
      getEnabled: () => true,
      getResolvedActive: type => ({ presetId: `${type}-1`, source: 'session', preset: { outputRules: presetRule } }),
      list: () => [],
    },
    regexStore: { computeActiveRules: () => [] },
    personaStore: { getActive: () => ({ id: 'p1', updated: 5, description: '角色描述' }) },
    contactsStore: { getContact: id => ({ id, updatedAt: 8, members: [] }) },
    getUiMode: () => 'rp',
    getRegexContext: options => options,
    getResolvedWorldState: () => ({ worldIds: ['w1'] }),
    getWorldInfoMetadata: id => ({ name: id, updatedAt: worldRevision, entriesCount: 2 }),
  });
  const first = resolver({ sessionId: 's1', sources: [{ type: 'worldbook', ref: 'w1' }] });
  const same = resolver({ sessionId: 's1', sources: [{ type: 'worldbook', ref: 'w1' }] });
  assert.equal(first.fingerprint, same.fingerprint);
  presetRule = 'B';
  const presetChanged = resolver({ sessionId: 's1', sources: [{ type: 'worldbook', ref: 'w1' }] });
  assert.notEqual(first.fingerprint, presetChanged.fingerprint);
  worldRevision = 11;
  const worldChanged = resolver({ sessionId: 's1', sources: [{ type: 'worldbook', ref: 'w1' }] });
  assert.notEqual(presetChanged.fingerprint, worldChanged.fingerprint);
  console.log('ok - APP 来源解析器纳入实际预设、世界书、正则上下文与角色 revision');
}


{
  // 大预设指纹缓存：走只读窥视接口时与复制路径指纹一致；同一对象同一 revision 只序列化一次；revision 变化重新计算
  let reads = 0;
  const makePreset = rule => {
    const preset = { name: '大预设', prompts: [{ identifier: 'main', content: rule }] };
    Object.defineProperty(preset, 'outputRules', { enumerable: true, get: () => { reads += 1; return rule; } });
    return preset;
  };
  let preset = makePreset('A');
  let revision = 1;
  const baseStore = {
    getEnabled: type => type === 'openai',
    list: () => [],
  };
  const common = {
    regexStore: { computeActiveRules: () => [] },
    personaStore: { getActive: () => null },
    contactsStore: { getContact: () => null },
    getUiMode: () => 'rp',
  };
  const cloning = createMaidFormatProfileSourceStateResolver({
    ...common,
    presetStore: { ...baseStore, getResolvedActive: () => ({ presetId: 'big', source: 'global', preset: structuredClone({ ...preset }) }) },
  });
  const peeking = createMaidFormatProfileSourceStateResolver({
    ...common,
    presetStore: { ...baseStore, peekResolvedActive: () => ({ presetId: 'big', source: 'global', preset, revision }) },
  });
  const expected = cloning({ sessionId: 's1' }).fingerprint;
  reads = 0;
  assert.equal(peeking({ sessionId: 's1' }).fingerprint, expected, '窥视路径与复制路径指纹一致');
  assert.equal(peeking({ sessionId: 's1' }).fingerprint, expected);
  assert.equal(reads, 1, '同一预设对象、同一 revision 只序列化一次');
  revision = 2;
  peeking({ sessionId: 's1' });
  assert.equal(reads, 2, 'revision 变化后重新计算');
  preset = makePreset('B');
  assert.notEqual(peeking({ sessionId: 's1' }).fingerprint, expected, '预设换成新对象时指纹随内容变化');
  console.log('ok - 大预设内容指纹按对象与 revision 缓存，结果与复制路径一致');
}

console.log('maid-format-profile-store-tests passed');
