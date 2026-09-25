import assert from 'node:assert/strict';

import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { listAppFeatures } from '../../src/scripts/agent/app-feature-catalog.js';
import {
  MAID_CAPABILITY_RETRIEVER_VERSION,
  MAID_CAPABILITY_ROUTING_MODES,
  createMaidCapabilityRetriever,
  createMaidCapabilityRoutingRuntime,
  resolveCandidateCapabilitySelection,
} from '../../src/scripts/agent/maid-capability-routing.js';

const features = [
  {
    id: 'app.state.read',
    title: '读取当前状态',
    aliases: ['看看当前状态'],
    tools: ['app.read_state'],
    riskLevel: 'low',
    writes: false,
    panel: 'chat',
  },
  {
    id: 'app.resource.read',
    title: '读取资源',
    aliases: ['读取世界书'],
    tools: ['app.read_resource'],
    riskLevel: 'low',
    writes: false,
  },
  {
    id: 'danger.delete',
    title: '删除记录',
    aliases: ['删除这条记录'],
    tools: ['danger.delete'],
    riskLevel: 'high',
    writes: true,
  },
  {
    id: 'app.verify',
    title: '验证结果',
    aliases: ['验证'],
    tools: ['app.verify'],
    riskLevel: 'low',
    writes: false,
  },
  {
    id: 'app.capabilities.search',
    title: '搜索能力',
    aliases: ['找工具'],
    tools: ['app.search_feature'],
    riskLevel: 'low',
    writes: false,
  },
];

const registry = createAgentToolRegistry({
  permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
  logger: { warn() {} },
});
for (const name of ['app.read_state', 'app.read_resource', 'danger.delete', 'app.verify', 'app.search_feature']) {
  registry.register({
    name,
    schema: {
      type: 'object',
      properties: name === 'app.read_resource' ? { resource: { type: 'string' } } : {},
    },
    riskLevel: name === 'danger.delete' ? 'high' : 'low',
    execute: async () => ({ ok: true }),
  });
}

const retrievalLog = {
  decisions: [],
  requests: [],
  recordDecision(value) { this.decisions.push(value); },
  recordRequestSummary(value) { this.requests.push(value); },
};

const createCatalogRoutingHarness = () => {
  const catalogFeatures = listAppFeatures();
  const catalogRegistry = createAgentToolRegistry({
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { warn() {} },
  });
  const registered = new Set();
  catalogFeatures.forEach((feature) => {
    (Array.isArray(feature?.tools) ? feature.tools : []).forEach((name) => {
      if (registered.has(name)) return;
      registered.add(name);
      catalogRegistry.register({
        name,
        schema: { type: 'object', properties: {} },
        riskLevel: 'low',
        execute: async () => ({ ok: true }),
      });
    });
  });
  return { catalogFeatures, catalogRegistry };
};

{
  let calls = 0;
  const retriever = createMaidCapabilityRetriever({
    version: 'injected-v1',
    search: (_query, { features: sourceFeatures }) => {
      calls += 1;
      return [{ ...sourceFeatures.find(item => item.id === 'app.state.read'), score: 100 }];
    },
  });
  const result = retriever.retrieve('任意说法', { features, limit: 8 });
  assert.equal(result[0].id, 'app.state.read');
  assert.equal(retriever.version, 'injected-v1');
  assert.equal(calls, 1);
  console.log('ok - CapabilityRetriever exposes a replaceable retrieve interface');
}

{
  const retriever = createMaidCapabilityRetriever();
  const result = retriever.retrieve('where am I in the app？', { features, limit: 8 });
  assert.equal(MAID_CAPABILITY_RETRIEVER_VERSION, 'maid-capability-retriever-v4');
  assert.equal(result[0].id, 'app.state.read');
  assert.equal(result[0].retrievalReason, 'semantic_concept');
  console.log('ok - v4 hybrid retriever adds explainable local concept matches');
}

{
  const retriever = createMaidCapabilityRetriever();
  const batchFeature = {
    id: 'worldbook.bind_sessions',
    title: '批量绑定世界书到聊天室',
    aliases: ['给这些房都绑上世界书'],
    tools: ['worldbook.bind_sessions'],
    riskLevel: 'medium',
    writes: true,
  };
  const singleFeature = {
    id: 'worldbook.bind_session',
    title: '绑定世界书到聊天室',
    aliases: ['给聊天室绑定世界书'],
    tools: ['worldbook.bind_session'],
    riskLevel: 'medium',
    writes: true,
  };
  const result = retriever.retrieve('给这些房都绑上世界书「精灵抱抱」', {
    features: [...features, singleFeature, batchFeature],
    limit: 8,
  });
  assert.equal(result[0].id, 'worldbook.bind_sessions');
  assert.ok(result[0].conceptCodes.includes('worldbook_batch_bind'));
  console.log('ok - v4 retriever ranks batch worldbook binding above the single-session primitive');
}

{
  const retriever = createMaidCapabilityRetriever();
  const rpFeature = {
    id: 'worldbook.bind_rp_session',
    title: '绑定创意写作专属世界书',
    aliases: ['把汇总世界书只用于创意写作'],
    tools: ['worldbook.bind_rp_session'],
    riskLevel: 'medium',
    writes: true,
  };
  const result = retriever.retrieve('把人物汇总世界书只绑定到这个角色卡的创意写作，不要影响私聊', {
    features: [...features, rpFeature],
    limit: 8,
  });
  assert.equal(result[0].id, 'worldbook.bind_rp_session');
  assert.ok(result[0].conceptCodes.includes('worldbook_rp_bind'));
  console.log('ok - v4 retriever routes RP-only worldbook binding above ordinary chat binding');
}

{
  const retriever = createMaidCapabilityRetriever();
  for (const [input, id] of [
    ['把刚创建的世界书绑定到角色卡「乙」', 'worldbook.bind_persona'],
    ['给指定角色卡绑定世界书', 'worldbook.bind_persona'],
    ['把世界书绑定到角色卡的创意写作，只用于创意写作不要影响私聊', 'worldbook.bind_rp_session'],
    ['把世界书绑定到聊天室「乙」', 'worldbook.bind_session'],
  ]) {
    const result = retriever.retrieve(input, { features: listAppFeatures(), limit: 8 });
    assert.equal(result[0].id, id, input);
  }
  console.log('ok - character-card bindings are distinct from writing-only and room bindings');
}

{
  const retriever = createMaidCapabilityRetriever();
  const { catalogFeatures } = createCatalogRoutingHarness();
  const fixtures = [
    ['清理测试用的房间', 'session.delete_many', 'session_batch_delete'],
    ['批量删除测试角色卡', 'persona.delete_many', 'persona_batch_delete'],
    ['删除这些测试世界书', 'worldbook.delete_many', 'worldbook_batch_delete'],
    ['删除世界书重复条目', 'worldbook.delete_entries', 'worldbook_entry_delete'],
  ];
  for (const [input, featureId, conceptCode] of fixtures) {
    const result = retriever.retrieve(input, { features: catalogFeatures, limit: 8 });
    const match = result.find(item => item.id === featureId);
    assert.ok(match, `${input} should retrieve ${featureId}`);
    assert.ok(match.conceptCodes.includes(conceptCode), `${featureId} should expose ${conceptCode}`);
  }
  console.log('ok - v4 retriever distinguishes resource batch deletion from worldbook entry deletion');
}

{
  const retriever = createMaidCapabilityRetriever();
  const { catalogFeatures } = createCatalogRoutingHarness();
  const fixtures = [
    ['从现有联系人里创建一个侍奉部群聊', 'group.create', 'group_chat_create'],
    ['给侍奉部群聊加上雪乃和结衣', 'group.members.update', 'group_member_update'],
    ['打开建群界面让我自己选', 'group.create.open', 'group_create_panel'],
    ['只读确认「草帽一伙」群聊有哪些成员', 'app.resource.read', 'group_member_read'],
    ['只打开这个群聊给我看', 'session.open', 'session_open'],
  ];
  for (const [input, featureId, conceptCode] of fixtures) {
    const result = retriever.retrieve(input, { features: catalogFeatures, limit: 8 });
    const match = result.find(item => item.id === featureId);
    assert.ok(match, `${input} should retrieve ${featureId}`);
    assert.ok(match.conceptCodes.includes(conceptCode), `${featureId} should expose ${conceptCode}`);
  }
  console.log('ok - v4 retriever separates group creation, member reads/updates, opening, and create-panel navigation');
}

{
  const retriever = createMaidCapabilityRetriever();
  const { catalogFeatures } = createCatalogRoutingHarness();
  const fixtures = [
    [
      '给「V4F-V2观测站-B-0731」后台写入“【V4F-V2-B】只写不回”，必须 triggerReply:false 且 open:false。',
      'chat.send_message',
    ],
    [
      '在后台建立三个一次性聊天室「V4F-V2待删-E-0731」「V4F-V2待删-F-0731」「V4F-V2保留-G-0731」，已存在就复用，全部不要进入。',
      'session.create',
    ],
    [
      '读取会话列表，确认刚才只是预览，E、F 与保留的 G 都还存在。',
      'session.list',
    ],
    [
      '列出你目前保存的长期语义记忆，只返回 kind、key、简短内容和置信度；不要归档或删除。',
      'maid.memory.list',
    ],
    [
      '尝试归档一个明确不存在的记忆 ID「memory-v4f-v2-missing-404」；找不到就安全停止，不能改其他记忆。',
      'maid.memory.archive',
    ],
    [
      '前面所有工作完成后，现在只打开主要结果「V4F-V2霜港调查组-0731」给我看；不要逐个打开私聊，也不要发送消息。',
      'session.open',
    ],
    [
      '查询「V4F-V2观测站-A-0731」的世界书绑定，只读核对「V4F-V2档案库-0731」已启用。',
      'app.resource.read',
    ],
    [
      '不要复用头像附件；写回后读取真实状态确认。',
      'app.resource.read',
    ],
  ];
  for (const [input, featureId] of fixtures) {
    const result = retriever.retrieve(input, { features: catalogFeatures, limit: 8 });
    assert.ok(
      result.some(item => item.id === featureId),
      `${featureId} should be in the top-8 candidates for: ${input}`,
    );
  }
  console.log('ok - frozen V4F primary and natural-memory phrases remain in the retriever top-k');
}

{
  const { catalogFeatures, catalogRegistry } = createCatalogRoutingHarness();
  const runtime = createMaidCapabilityRoutingRuntime({
    features: catalogFeatures,
    toolRegistry: catalogRegistry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { debug() {} },
  });
  const input = '保持当前房间不变，分别向「记忆系统G35-0730·白塔」「记忆系统G35-0730·灰港」「记忆系统G35-0730·档案室」后台写入用户消息“G35-MEM-A”“G35-MEM-B”“G35-MEM-C”，全部 triggerReply:false、open:false；逐房读回末条消息核对，再读取 APP 状态。';
  const request = runtime.beginRequest({ input });
  const snapshot = runtime.prepareDecision({ requestId: request.id, input, phase: 'planner' });
  assert.equal(snapshot.candidateIds.has('chat.send_message'), true, '“分别”不得吞掉后续发送意图');
  assert.equal(snapshot.candidateIds.has('maid.todo'), true, '三目标发送、读回与状态核对必须识别为复杂工作流');
  runtime.finishRequest(request.id, { ok: true });
  console.log('ok - exact multi-room wording retains chat send and complex-workflow candidates');
}

{
  // 提示词只列名称索引：模型读过某功能的说明后，下一步它必须进入候选，才能真正调用
  const { catalogFeatures, catalogRegistry } = createCatalogRoutingHarness();
  const runtime = createMaidCapabilityRoutingRuntime({
    features: catalogFeatures,
    toolRegistry: catalogRegistry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { debug() {} },
  });
  const input = '帮我看看正则规则集';
  const request = runtime.beginRequest({ input });
  const before = runtime.prepareDecision({ requestId: request.id, input, phase: 'react', steps: [], configOverride: { mode: 'bounded' } });
  assert.equal(before.candidateIds.has('worldbook.open'), false);
  const after = runtime.prepareDecision({
    requestId: request.id, input, phase: 'react', configOverride: { mode: 'bounded' },
    steps: [{ toolName: 'app.read_feature_doc', status: 'succeeded', args: { featureId: 'worldbook.open' } }],
  });
  assert.equal(after.candidateIds.has('worldbook.open'), true, 'looked-up feature becomes a candidate');
  const failedLookup = runtime.prepareDecision({
    requestId: request.id, input, phase: 'react', configOverride: { mode: 'bounded' },
    steps: [{ toolName: 'app.read_feature_doc', status: 'failed', args: { featureId: 'worldbook.open' } }],
  });
  assert.equal(failedLookup.candidateIds.has('worldbook.open'), false);
  runtime.finishRequest(request.id, { ok: true });
  console.log('ok - a feature doc the maid just read becomes a pinned candidate for the next step');
  const skillRequest = runtime.beginRequest({ input: '帮我整理这些资料' });
  const withSkill = runtime.prepareDecision({ requestId: skillRequest.id, input: '帮我整理这些资料', phase: 'react', configOverride: { mode: 'bounded' },
    steps: [{ toolName: 'app.read_skill', status: 'succeeded', args: { skillId: 'worldbook.from_sources' } }] });
  assert(withSkill.candidateIds.size <= 8, 'workflow references stay within the candidate budget');
  assert(withSkill.candidateIds.has('app.capabilities.search'), 'the lookup path stays available');
  assert(!withSkill.candidateIds.has('worldbook.delete_many'), 'a workflow does not grant unrelated destructive capabilities');
  assert(withSkill.candidateIds.has('worldbook.read'), 'workflow references can reveal the next relevant capability');
  runtime.finishRequest(skillRequest.id, { ok: true });
}

{
  const { catalogFeatures, catalogRegistry } = createCatalogRoutingHarness();
  const runtime = createMaidCapabilityRoutingRuntime({
    features: catalogFeatures,
    toolRegistry: catalogRegistry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { debug() {} },
  });
  const cases = [
    {
      input: '请求批量删除 E、F；出现最终删除确认列表时取消，验证取消路径不应删除任何聊天室。',
      step: {
        toolName: 'session.delete_many',
        featureId: 'session.delete_many',
        status: 'succeeded',
        args: { sessions: ['E', 'F'] },
        output: { ok: true, cancelled: true },
      },
      expected: 'session.list',
    },
    {
      input: '只生成一张横向壁纸；失败就停止，不能使用旧附件。',
      step: {
        toolName: 'media.generate_image',
        featureId: 'media.generate_image',
        status: 'failed',
        args: { target: '艾琳·洛', purpose: 'wallpaper', targetAspectRatio: '16:9' },
        output: { ok: false, reason: '当前生图配置锁定为 1024×1024 方形输出' },
      },
      expected: 'config.model.switch',
    },
    {
      input: '只读核对联系人头像和私聊壁纸，读取真实资源状态，不要重新生成或设置。',
      step: {
        toolName: 'app.read_resource',
        featureId: 'app.resource.read',
        status: 'failed',
        args: { resource: 'session', sessionName: '艾琳·洛', include: ['wallpaper'] },
        output: { ok: false, reason: 'session_not_found' },
      },
      expected: 'session.list',
    },
    {
      input: '先用 maid.memory.list 精确找到这条探针偏好，再用 maid.memory.archive 软归档。',
      step: {
        toolName: 'maid.memory.list',
        featureId: 'maid.memory.list',
        status: 'succeeded',
        args: { query: '探针偏好' },
        output: { ok: true, items: [{ id: 'memory-probe' }] },
      },
      expected: 'maid.memory.archive',
    },
  ];
  for (const testCase of cases) {
    const request = runtime.beginRequest({ input: testCase.input });
    const snapshot = runtime.prepareDecision({
      requestId: request.id,
      input: testCase.input,
      steps: [testCase.step],
      phase: 'react',
    });
    assert.ok(
      snapshot.candidateIds.has(testCase.expected),
      `${testCase.expected} should remain available after ${testCase.step.toolName}`,
    );
    runtime.finishRequest(request.id, { ok: true });
  }
  console.log('ok - bounded cross-domain verification dependencies survive V4F ReAct transitions');
}

{
  const { catalogFeatures, catalogRegistry } = createCatalogRoutingHarness();
  const runtime = createMaidCapabilityRoutingRuntime({
    features: catalogFeatures,
    toolRegistry: catalogRegistry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { debug() {} },
  });
  const input = '只做删除预览，不得实际删除：分别预览批量删除测试聊天室「白塔」「灰港」「档案室」、测试角色卡「记录员」「观察员」和测试世界书「资料库」。三个资源域必须分开调用各自 delete_many 且 preview:true。';
  const request = runtime.beginRequest({ input });
  const snapshot = runtime.prepareDecision({ requestId: request.id, input, phase: 'planner' });
  for (const featureId of ['session.delete_many', 'persona.delete_many', 'worldbook.delete_many']) {
    assert.equal(snapshot.candidateIds.has(featureId), true, `三域预览应召回 ${featureId}`);
  }
  runtime.finishRequest(request.id, { ok: true });
  console.log('ok - exact three-domain preview keeps every explicitly requested delete capability');
}

{
  const { catalogFeatures, catalogRegistry } = createCatalogRoutingHarness();
  const runtime = createMaidCapabilityRoutingRuntime({
    features: catalogFeatures,
    toolRegistry: catalogRegistry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { debug() {} },
  });
  const input = '保持后台做清理后只读审计：读取会话、角色卡、世界书、用户清单和 APP 状态，确认测试房、测试角色卡与测试世界书已不存在。不得补删或切换。';
  const request = runtime.beginRequest({ input });
  const snapshot = runtime.prepareDecision({ requestId: request.id, input, phase: 'planner' });
  for (const featureId of ['session.list', 'app.resource.read', 'worldbook.list', 'app.state.read']) {
    assert.equal(snapshot.candidateIds.has(featureId), true, `只读审计应召回 ${featureId}`);
  }
  for (const featureId of ['session.delete_many', 'persona.delete_many', 'worldbook.delete_many']) {
    assert.equal(snapshot.candidateIds.has(featureId), false, `“清理后/已不存在/不得补删”不得召回 ${featureId}`);
  }
  runtime.finishRequest(request.id, { ok: true });
  console.log('ok - post-cleanup read-only audit excludes destructive capabilities');
}

{
  const { catalogFeatures, catalogRegistry } = createCatalogRoutingHarness();
  const runtime = createMaidCapabilityRoutingRuntime({
    features: catalogFeatures,
    toolRegistry: catalogRegistry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { debug() {} },
  });
  const input = '生成一张极简蓝色灯塔图片，再复用同一 attachmentId 给「白塔」设置联系人头像、给「灰港」设置聊天室壁纸 opacity:0.3。';
  const request = runtime.beginRequest({ input });
  const afterAvatar = runtime.prepareDecision({
    requestId: request.id,
    input,
    phase: 'react',
    steps: [{
      toolName: 'contact.set_avatar',
      featureId: 'contact.avatar.set',
      status: 'succeeded',
      args: { sessionName: '白塔', attachmentId: 'generated-1' },
      output: { ok: true, attachmentId: 'generated-1' },
    }],
  });
  assert.equal(
    afterAvatar.candidateIds.has('session.wallpaper.set'),
    true,
    '完成头像后仍须保留同图壁纸 sibling',
  );
  runtime.finishRequest(request.id, { ok: true });
  console.log('ok - generated-image reuse keeps the unfinished wallpaper sibling');
}

{
  const { catalogFeatures, catalogRegistry } = createCatalogRoutingHarness();
  const runtime = createMaidCapabilityRoutingRuntime({
    features: catalogFeatures,
    toolRegistry: catalogRegistry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { debug() {} },
  });
  const input = '分别向「白塔」「灰港」「档案室」后台写入用户消息“A”“B”“C”，全部 triggerReply:false、open:false。';
  const request = runtime.beginRequest({ input });
  const afterMissingInventory = runtime.prepareDecision({
    requestId: request.id,
    input,
    phase: 'react',
    steps: [{
      toolName: 'session.list',
      featureId: 'session.list',
      status: 'succeeded',
      args: {},
      output: { count: 1, contacts: [{ id: '正式房', name: '正式房' }] },
    }],
  });
  const createRef = afterMissingInventory.candidateRefs.find(item => item.id === 'session.create');
  assert.ok(createRef, '真实清单缺少精确消息目标时应提供 session.create 前置能力');
  assert.ok(createRef.reasonCodes.includes('missing_session_prerequisite'));
  runtime.finishRequest(request.id, { ok: true });
  console.log('ok - missing exact chat targets add a bounded session-create prerequisite');
}

{
  const { catalogFeatures, catalogRegistry } = createCatalogRoutingHarness();
  const runtime = createMaidCapabilityRoutingRuntime({
    features: catalogFeatures,
    toolRegistry: catalogRegistry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { debug() {} },
  });
  const input = '重复执行幂等核对：用一次 session.create(names[]) 请求「复杂压力·岚」「复杂压力·弦」，不得新增重名房；再用一次 worldbook.bind_sessions 把「复杂压力·资料」append 到两房。最后只根据工具结果说明 createdCount、already_bound/skipped 与 verified，不要逐房重复绑定或打开页面。';
  const request = runtime.beginRequest({ input });
  const snapshot = runtime.prepareDecision({ requestId: request.id, input, phase: 'planner' });
  assert.ok(snapshot.candidateIds.has('session.create'), '原句明确写出的 session.create 必须进入首轮候选');
  runtime.finishRequest(request.id, { ok: true });
  console.log('ok - complex idempotency request retains the explicit session.create subgoal');
}

{
  const { catalogFeatures, catalogRegistry } = createCatalogRoutingHarness();
  const runtime = createMaidCapabilityRoutingRuntime({
    features: catalogFeatures,
    toolRegistry: catalogRegistry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { debug() {} },
  });
  const input = '建立测试用户「复杂压力·用户」和测试角色卡「复杂压力·角色」，两者若已有就复用；setActive 必须为 false。创建前后都读取用户与角色卡清单，确认各自只出现一次，而且当前用户、当前角色卡没有变化。不要设置头像或关联正式世界书。';
  const steps = [
    {
      toolName: 'app.read_resource',
      featureId: 'app.resource.read',
      status: 'succeeded',
      args: { resource: 'user' },
      output: { ok: true, resource: 'user', items: [] },
    },
    {
      toolName: 'app.read_resource',
      featureId: 'app.resource.read',
      status: 'succeeded',
      args: { resource: 'persona' },
      output: { ok: true, resource: 'persona', items: [] },
    },
  ];
  const request = runtime.beginRequest({ input });
  const afterReads = runtime.prepareDecision({
    requestId: request.id,
    input,
    steps,
    phase: 'react',
  });
  assert.ok(afterReads.candidateIds.has('user.create'), '读取清单后仍须保留用户创建子目标');
  assert.ok(afterReads.candidateIds.has('persona.create'), '读取清单后仍须保留角色卡创建子目标');
  runtime.observeDecision(afterReads, {
    ok: true,
    featureId: 'user.create',
    toolName: 'user.create',
    args: { name: '复杂压力·用户', setActive: false },
  });
  const afterUserCreate = runtime.prepareDecision({
    requestId: request.id,
    input,
    steps: [
      ...steps,
      {
        toolName: 'user.create',
        featureId: 'user.create',
        status: 'succeeded',
        args: { name: '复杂压力·用户', setActive: false },
        output: { ok: true, created: true },
      },
    ],
    phase: 'react',
  });
  assert.ok(afterUserCreate.candidateIds.has('persona.create'), '完成用户创建后 sibling 角色卡创建能力不能被挤出');
  runtime.finishRequest(request.id, { ok: true });
  console.log('ok - user and persona sibling creation subgoals survive sequential ReAct steps');
}

{
  const { catalogFeatures, catalogRegistry } = createCatalogRoutingHarness();
  const runtime = createMaidCapabilityRoutingRuntime({
    features: catalogFeatures,
    toolRegistry: catalogRegistry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { debug() {} },
  });
  const input = '保持当前房间不变，向三个测试房后台各写一条用户消息：给「扩面压力·观测站」写“OBS-A”，给「扩面压力·档案室」写“OBS-B”，给「扩面压力·检查站」写“OBS-C”；全部必须 triggerReply:false、open:false。然后分别用结构化 chat 资源读取三房最后一条消息，逐一核对角色与完整正文；最后读取 APP 状态证明仍在「格式修复测试」。';
  const request = runtime.beginRequest({ input });
  const first = runtime.prepareDecision({
    requestId: request.id,
    input,
    phase: 'planner',
  });
  assert.ok(first.candidateIds.has('chat.send_message'), '“各写一条用户消息”必须在首轮召回 chat.send_message');

  const afterFirstReadback = runtime.prepareDecision({
    requestId: request.id,
    input,
    steps: [
      {
        toolName: 'chat.send_message',
        featureId: 'chat.send_message',
        status: 'succeeded',
        args: {
          sessionName: '扩面压力·观测站',
          content: 'OBS-A',
          triggerReply: false,
          open: false,
        },
        output: { ok: true, sessionId: '扩面压力·观测站' },
      },
      {
        toolName: 'app.read_resource',
        featureId: 'app.resource.read',
        status: 'succeeded',
        args: { resource: 'chat', sessionName: '扩面压力·观测站', limit: 1 },
        output: { ok: true, resource: 'chat', messages: [{ role: 'user', content: 'OBS-A' }] },
      },
    ],
    phase: 'react',
  });
  assert.ok(
    afterFirstReadback.candidateIds.has('chat.send_message'),
    '读回第一房后仍有两个 sibling 发送目标，chat.send_message 不能从候选消失',
  );
  runtime.finishRequest(request.id, { ok: true });
  console.log('ok - repeated sibling chat sends survive readback and ReAct replanning');
}

{
  const { catalogFeatures, catalogRegistry } = createCatalogRoutingHarness();
  const runtime = createMaidCapabilityRoutingRuntime({
    features: catalogFeatures,
    toolRegistry: catalogRegistry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { debug() {} },
  });
  const input = '读取「复杂压力·资料」后自行区分人物、地点与事件，只为其中两个主要人物建立聊天室「复杂压力·岚」「复杂压力·弦」。先查会话列表，再用一次批量创建补齐缺少项，open:false，不得给灰港或共同事件建房；最后核对两个名称各只出现一次。';
  const request = runtime.beginRequest({ input });
  const first = runtime.prepareDecision({ requestId: request.id, input, phase: 'planner' });
  runtime.observeDecision(first, {
    ok: true,
    featureId: 'session.list',
    toolName: 'session.list',
    args: {},
  });
  const afterSessionList = runtime.prepareDecision({
    requestId: request.id,
    input,
    steps: [{
      toolName: 'session.list',
      featureId: 'session.list',
      status: 'succeeded',
      args: {},
      output: { count: 2, contacts: [] },
    }],
    phase: 'react',
  });
  assert.ok(afterSessionList.candidateIds.has('worldbook.read'), '先查会话后必须保留读取人物资料的原始子目标');
  runtime.finishRequest(request.id, { ok: true });
  console.log('ok - execution order does not drop the original worldbook read subgoal');
}

{
  const runtime = createMaidCapabilityRoutingRuntime({
    features,
    toolRegistry: registry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    retrievalStore: retrievalLog,
    now: (() => { let value = 1000; return () => value += 1; })(),
    logger: { debug() {} },
  });
  const request = runtime.beginRequest({ input: '看看当前状态', context: { uiMode: 'chat' } });
  const snapshot = runtime.prepareDecision({
    requestId: request.id,
    input: '看看当前状态',
    context: {
      uiMode: 'chat',
      activePage: 'chat',
      maidConversationContextRef: {
        current: { maidContextVersion: 'maid-context-test' },
      },
    },
    phase: 'planner',
  });
  assert.equal(snapshot.mode, MAID_CAPABILITY_ROUTING_MODES.shadow);
  assert.equal(snapshot.useCandidates, false);
  assert.equal(snapshot.promptFeatures.length, features.length, 'Shadow 必须继续注入全量目录');
  assert.ok(snapshot.candidateIds.has('app.state.read'));
  assert.ok(snapshot.estimatedFullSchemaTokens >= snapshot.estimatedCandidateSchemaTokens);
  const observed = runtime.observeDecision(snapshot, {
    ok: true,
    featureId: 'app.state.read',
    toolName: 'app.read_state',
    args: {},
  });
  assert.equal(observed.candidateSnapshotId, snapshot.id);
  assert.equal(observed.candidateHit, true);
  const summary = runtime.finishRequest(request.id, { ok: true });
  assert.equal(summary.validSelectionCount, 1);
  assert.equal(summary.effectiveMode, 'shadow');
  assert.equal(summary.allValidSelectionsCovered, true);
  assert.equal(retrievalLog.decisions.at(-1).candidateHit, true);
  assert.ok(retrievalLog.decisions.at(-1).selectedRank > 0);
  assert.equal(
    retrievalLog.decisions.at(-1).reciprocalRank,
    1 / retrievalLog.decisions.at(-1).selectedRank,
  );
  assert.equal(retrievalLog.requests.length, 1);
  assert.equal(retrievalLog.requests.at(-1).cohort.riskLevel, 'low');
  assert.equal(retrievalLog.decisions.at(-1).cohort.maidContextVersion, 'maid-context-test');
  assert.equal(retrievalLog.requests.at(-1).cohort.maidContextVersion, 'maid-context-test');
  console.log('ok - Shadow computes candidates and hit metrics without changing full prompt features');
}

{
  let contextCalls = 0;
  const runtime = createMaidCapabilityRoutingRuntime({
    features,
    toolRegistry: registry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    getConversationContext: () => {
      contextCalls += 1;
      return { historyText: '上一轮用户说：看看当前状态。' };
    },
    logger: { debug() {} },
  });
  const request = runtime.beginRequest({ input: '再看一下。' });
  const snapshot = runtime.prepareDecision({
    requestId: request.id,
    input: '再看一下。',
    phase: 'planner',
  });
  assert.equal(contextCalls, 1);
  const state = snapshot.candidateRefs.find(item => item.id === 'app.state.read');
  assert.ok(state);
  assert.ok(state.reasonCodes.includes('history_context'));
  runtime.finishRequest(request.id, { ok: true });
  console.log('ok - ambiguous planner retrieval can use recent maid conversation context');
}

{
  let contextCalls = 0;
  const frozenContext = { historyText: '上一轮用户说：看看当前状态。' };
  const sharedRef = { current: frozenContext };
  const runtime = createMaidCapabilityRoutingRuntime({
    features,
    toolRegistry: registry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    getConversationContext: () => {
      contextCalls += 1;
      return { historyText: '不应重新构建的历史。' };
    },
    logger: { debug() {} },
  });
  const context = { maidConversationContextRef: sharedRef };
  const request = runtime.beginRequest({ input: '再看一下。', context });
  const snapshot = runtime.prepareDecision({
    requestId: request.id,
    input: '再看一下。',
    context,
    phase: 'planner',
  });
  assert.equal(contextCalls, 0, 'Capability routing 必须使用 Run 开始前已冻结的异步快照');
  assert.equal(sharedRef.current, frozenContext);
  assert.ok(snapshot.candidateRefs.find(item => item.id === 'app.state.read'));
  runtime.finishRequest(request.id, { ok: true });
  console.log('ok - capability routing reuses the prepared conversation snapshot');
}

{
  // v2：react 中段的步骤级召回——maid.todo 常驻候选 + todo 计划文本参与检索
  const todoFeatures = [
    ...features,
    {
      id: 'maid.todo',
      title: '女仆任务清单',
      aliases: ['待办清单'],
      tools: ['maid.todo.write', 'maid.todo.read'],
      riskLevel: 'low',
      writes: false,
    },
    {
      id: 'web.search',
      title: '联网搜索网页',
      aliases: ['联网搜索白猫图片'],
      tools: ['web.search'],
      riskLevel: 'low',
      writes: false,
    },
  ];
  const todoRegistry = createAgentToolRegistry({
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { warn() {} },
  });
  for (const name of ['app.read_state', 'app.read_resource', 'danger.delete', 'app.verify', 'app.search_feature', 'maid.todo.write', 'maid.todo.read', 'web.search']) {
    todoRegistry.register({
      name,
      schema: { type: 'object', properties: {} },
      riskLevel: 'low',
      execute: async () => ({ ok: true }),
    });
  }
  const runtime = createMaidCapabilityRoutingRuntime({
    features: todoFeatures,
    toolRegistry: todoRegistry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    retrievalStore: retrievalLog,
    logger: { debug() {} },
  });
  const request = runtime.beginRequest({ input: '帮我完成任务' });

  const plannerSnapshot = runtime.prepareDecision({
    requestId: request.id,
    input: '帮我完成任务',
    context: { uiMode: 'chat' },
    phase: 'planner',
  });
  assert.equal(plannerSnapshot.candidateIds.has('maid.todo'), false, 'planner 阶段不应常驻 todo');

  const reactSnapshot = runtime.prepareDecision({
    requestId: request.id,
    input: '帮我完成任务',
    context: { uiMode: 'chat' },
    steps: [
      {
        toolName: 'maid.todo.write',
        status: 'succeeded',
        // todos 放 args（observation 查询只含 output 文本），隔离验证 todo_plan 通道
        args: {
          todos: [
            { content: '联网搜索白猫图片', status: 'pending' },
            { content: '看看当前状态', status: 'completed' },
          ],
        },
        output: { ok: true, count: 2 },
      },
    ],
    phase: 'react',
  });
  assert.equal(reactSnapshot.candidateIds.has('maid.todo'), true, 'react 阶段 todo 应常驻候选');
  const todoRef = reactSnapshot.candidateRefs.find(item => item.ref === 'maid.todo' || item.id === 'maid.todo');
  assert.ok(todoRef.reasonCodes.includes('multi_step_todo'));
  assert.equal(reactSnapshot.candidateIds.has('web.search'), true, '未完成 todo 项文本应召回对应能力');
  const webRef = reactSnapshot.candidateRefs.find(item => item.ref === 'web.search' || item.id === 'web.search');
  assert.ok(webRef.reasonCodes.includes('todo_plan'));
  assert.equal(reactSnapshot.candidateIds.has('app.state.read'), false, '已完成 todo 项不应参与召回');

  const observed = runtime.observeDecision(reactSnapshot, {
    ok: true,
    featureId: 'maid.todo',
    toolName: 'maid.todo.write',
    args: {},
  });
  assert.equal(observed.candidateHit, true, 'react 自发写 todo 应计为命中');
  runtime.finishRequest(request.id, { ok: true });
  console.log('ok - react phase pins maid.todo and recalls capabilities from pending todo plan text');
}

{
  const runtime = createMaidCapabilityRoutingRuntime({
    features,
    toolRegistry: registry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    retrievalStore: retrievalLog,
    logger: { debug() {} },
  });
  runtime.setConfig({ mode: 'canary', canaryPercent: 100, minScore: 45 });
  const request = runtime.beginRequest({ input: '读取世界书' });
  const first = runtime.prepareDecision({
    requestId: request.id,
    input: '读取世界书',
    context: {},
    phase: 'planner',
  });
  assert.equal(first.useCandidates, true);
  assert.ok(first.promptFeatures.length < features.length);
  const readFeature = first.candidateFeatures.find(item => item.id === 'app.resource.read');
  assert.equal(readFeature.toolSchemas['app.read_resource'].type, 'object');

  const corrected = resolveCandidateCapabilitySelection({
    featureId: 'app.resource.reed',
    toolName: 'app.read_resource',
    features: first.candidateFeatures,
  });
  assert.equal(corrected.ok, true);
  assert.equal(corrected.feature.id, 'app.resource.read');
  assert.equal(corrected.correction.rule, 'unique_tool_owner');
  const lowRiskFuzzy = resolveCandidateCapabilitySelection({
    featureId: 'app.resource.rea',
    toolName: 'app.read_resourc',
    features: first.candidateFeatures,
  });
  assert.equal(lowRiskFuzzy.ok, true);
  assert.equal(lowRiskFuzzy.feature.id, 'app.resource.read');
  assert.equal(lowRiskFuzzy.toolName, 'app.read_resource');

  const observed = runtime.observeDecision(first, {
    ok: true,
    featureId: 'app.resource.read',
    toolName: 'app.read_resource',
    args: { resource: 'worldbook' },
  });
  const validated = runtime.validatePlan(observed, { context: {} });
  assert.equal(validated.ok, true);

  const second = runtime.prepareDecision({
    requestId: request.id,
    input: '完全不同的下一步',
    context: { maidReactSteps: [{ featureId: 'app.resource.read', toolName: 'app.read_resource' }] },
    steps: [{ featureId: 'app.resource.read', toolName: 'app.read_resource' }],
    phase: 'react',
  });
  assert.notEqual(second.id, first.id);
  assert.equal(second.rolloutBucket, first.rolloutBucket, '同一 request 的 Canary 分桶必须跨 ReAct 决策稳定');
  assert.ok(second.candidateIds.has('app.resource.read'), '上一能力应作为 bounded sticky 保留');

  const verification = runtime.authorizeVerification({
    requestId: request.id,
    parentPlan: observed,
    verificationPlan: {
      ok: true,
      action: 'tool',
      featureId: 'app.verify',
      toolName: 'app.verify',
      args: {},
    },
  });
  assert.match(verification.candidateSnapshotId, /^cap-verify:/);
  assert.equal(retrievalLog.decisions.at(-1).metricEligible, false);
  assert.equal(runtime.validatePlan(verification, { context: {} }).ok, true);
  assert.equal(runtime.finishRequest(request.id, { ok: true }).effectiveMode, 'candidate');
  console.log('ok - Canary uses schema-aware candidates, per-decision snapshots, sticky reuse, and verification child snapshots');
}

{
  const { catalogFeatures, catalogRegistry } = createCatalogRoutingHarness();
  const workflowLog = {
    decisions: [],
    recordDecision(value) { this.decisions.push(value); },
  };
  const runtime = createMaidCapabilityRoutingRuntime({
    features: catalogFeatures,
    toolRegistry: catalogRegistry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    retrievalStore: workflowLog,
    logger: { debug() {} },
  });
  runtime.setConfig({ mode: 'bounded' });
  const input = '进行最终只读审计，不得补写或打开页面：读取「档案库」全文索引；读取完整会话清单；读取测试用户与测试角色卡清单；分别读取「观测站」「档案室」「检查站」的格式画像；再读取 APP 状态。';
  const request = runtime.beginRequest({ input });
  const snapshot = runtime.prepareDecision({
    requestId: request.id,
    input,
    phase: 'planner',
  });
  assert.equal(snapshot.useCandidates, true);
  assert.equal(snapshot.candidateIds.has('worldbook.read'), false, '此用例必须覆盖目标不在普通 Top-N 的边界');
  const parentPlan = runtime.observeDecision(snapshot, {
    ok: true,
    featureId: 'session.list',
    toolName: 'session.list',
    args: {},
  });
  const workflowPlan = runtime.authorizeWorkflowPlan({
    requestId: request.id,
    parentPlan,
    workflowPlan: {
      ok: true,
      action: 'tool',
      featureId: 'worldbook.read',
      toolName: 'worldbook.read',
      args: { name: '档案库' },
    },
  });
  assert.match(workflowPlan.candidateSnapshotId, /^cap-workflow:/);
  assert.equal(runtime.validatePlan(workflowPlan).ok, true);
  assert.equal(workflowLog.decisions.at(-1).phase, 'deterministic_workflow');
  assert.equal(workflowLog.decisions.at(-1).metricEligible, false);
  assert.equal(workflowLog.decisions.at(-1).validSelection, false);
  console.log('ok - deterministic workflow child plans get exact non-metric capability snapshots');
}

{
  const runtime = createMaidCapabilityRoutingRuntime({
    features,
    toolRegistry: registry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { debug() {} },
  });
  runtime.setConfig({ mode: 'bounded', candidateLimit: 3, stickyLimit: 4 });
  assert.equal(runtime.getConfig().stickyLimit, 1, '小候选集必须为当前意图和 control plane 留出位置');
  assert.equal(runtime.validatePlan({ featureId: 'legacy.feature' }).ok, true);
  assert.equal(runtime.validatePlan({ capabilityRoutingMode: 'candidate' }).reason, 'candidate_snapshot_missing');
  const missingSnapshot = runtime.validatePlan({
    candidateSnapshotId: 'cap-snapshot:missing',
    featureId: 'app.state.read',
    toolName: 'app.read_state',
  });
  assert.equal(missingSnapshot.ok, false);
  assert.equal(missingSnapshot.reason, 'candidate_snapshot_missing');
  const request = runtime.beginRequest({ input: '看看当前状态' });
  const snapshot = runtime.prepareDecision({ requestId: request.id, input: '看看当前状态' });
  const outside = runtime.validatePlan({
    candidateSnapshotId: snapshot.id,
    featureId: 'outside.feature',
    toolName: 'outside.tool',
  });
  assert.equal(outside.ok, false);
  assert.equal(outside.reason, 'feature_not_found');

  const deleteRequest = runtime.beginRequest({ input: '删除这条记录' });
  const deleteSnapshot = runtime.prepareDecision({
    requestId: deleteRequest.id,
    input: '删除这条记录',
  });
  assert.ok(deleteSnapshot.candidateIds.has('danger.delete'));
  const riskyFuzzy = resolveCandidateCapabilitySelection({
    featureId: 'danger.delet',
    toolName: 'danger.delet',
    features: deleteSnapshot.candidateFeatures,
  });
  assert.equal(riskyFuzzy.ok, false, '高风险能力不得仅凭编辑距离自动纠偏');

  runtime.setConfig({ mode: 'canary', canaryPercent: 100 });
  const fallbackRequest = runtime.beginRequest({ input: '完全无法识别的长尾请求 xyz-987' });
  const fallback = runtime.prepareDecision({
    requestId: fallbackRequest.id,
    input: '完全无法识别的长尾请求 xyz-987',
  });
  assert.equal(fallback.useCandidates, false);
  assert.equal(fallback.effectiveMode, 'full_fallback');
  assert.equal(fallback.promptFeatures.length, features.length);

  runtime.setConfig({ mode: 'shadow' });
  const rollback = runtime.prepareDecision({ requestId: request.id, input: '看看当前状态' });
  assert.equal(rollback.useCandidates, false);
  assert.equal(rollback.promptFeatures.length, features.length);
  console.log('ok - bounded Validator rejects outside/high-risk fuzzy choices and rollback restores full visibility');
}

{
  const policyLog = { decisions: [], recordDecision(value) { this.decisions.push(value); } };
  const runtime = createMaidCapabilityRoutingRuntime({
    features,
    toolRegistry: registry,
    permissionEvaluator: {
      evaluateTool: tool => ({ decision: tool.name === 'danger.delete' ? 'deny' : 'allow', checks: [] }),
    },
    retrievalStore: policyLog,
    logger: { debug() {} },
  });
  const request = runtime.beginRequest({ input: '删除这条记录' });
  const snapshot = runtime.prepareDecision({ requestId: request.id, input: '删除这条记录' });
  assert.equal(snapshot.candidateIds.has('danger.delete'), false);
  runtime.observeDecision(snapshot, {
    ok: true,
    featureId: 'danger.delete',
    toolName: 'danger.delete',
    args: {},
  });
  assert.equal(policyLog.decisions[0].policyExcluded, true);
  assert.equal(policyLog.decisions[0].validSelection, false);
  assert.equal(runtime.finishRequest(request.id, { ok: false }).validSelectionCount, 0);
  console.log('ok - permission-denied selections are policyExcluded rather than retrieval misses');
}

{
  const policyLog = { decisions: [], recordDecision(value) { this.decisions.push(value); } };
  const runtime = createMaidCapabilityRoutingRuntime({
    features: [{
      id: 'android.only',
      title: 'Android 专用能力',
      aliases: ['执行 Android 专用能力'],
      tools: ['android.only'],
      allowedPlatforms: ['android'],
      riskLevel: 'low',
      writes: false,
    }],
    toolRegistry: registry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    retrievalStore: policyLog,
    logger: { debug() {} },
  });
  const request = runtime.beginRequest({ input: '执行 Android 专用能力' });
  const snapshot = runtime.prepareDecision({
    requestId: request.id,
    input: '执行 Android 专用能力',
    context: { platform: 'windows' },
  });
  assert.equal(snapshot.excluded[0].reason, 'platform_mismatch');
  runtime.observeDecision(snapshot, {
    ok: true,
    featureId: 'android.only',
    toolName: 'android.only',
  });
  assert.equal(policyLog.decisions[0].policyExcluded, true);
  console.log('ok - platform-incompatible capabilities are hard-filtered before ranking');
}

{
  const policyLog = { decisions: [], recordDecision(value) { this.decisions.push(value); } };
  const runtime = createMaidCapabilityRoutingRuntime({
    features: [{
      id: 'mislabelled.danger',
      title: '查看危险记录',
      aliases: ['查看危险记录'],
      tools: ['danger.delete'],
      riskLevel: 'low',
      writes: false,
    }],
    toolRegistry: registry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    retrievalStore: policyLog,
    logger: { debug() {} },
  });
  const request = runtime.beginRequest({ input: '查看危险记录' });
  const snapshot = runtime.prepareDecision({ requestId: request.id, input: '查看危险记录' });
  assert.equal(snapshot.excluded[0].reason, 'risk_intent_not_explicit');
  runtime.observeDecision(snapshot, {
    ok: true,
    featureId: 'mislabelled.danger',
    toolName: 'danger.delete',
  });
  assert.equal(policyLog.decisions[0].policyExcluded, true);
  assert.equal(policyLog.decisions[0].cohort.riskLevel, 'high');
  console.log('ok - Tool Registry risk cannot be downgraded by catalog metadata');
}

{
  const missLog = { decisions: [], recordDecision(value) { this.decisions.push(value); } };
  const runtime = createMaidCapabilityRoutingRuntime({
    features,
    toolRegistry: registry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    retriever: { version: 'blind-v1', retrieve: () => [] },
    retrievalStore: missLog,
    logger: { debug() {} },
  });
  const request = runtime.beginRequest({ input: '删除这条记录' });
  const snapshot = runtime.prepareDecision({ requestId: request.id, input: '删除这条记录' });
  assert.equal(snapshot.excluded.some(item => item.id === 'danger.delete'), false);
  assert.equal(snapshot.candidateIds.has('danger.delete'), false);
  runtime.observeDecision(snapshot, {
    ok: true,
    featureId: 'danger.delete',
    toolName: 'danger.delete',
    args: {},
  });
  assert.equal(missLog.decisions[0].policyExcluded, false);
  assert.equal(missLog.decisions[0].validSelection, true);
  assert.equal(missLog.decisions[0].candidateHit, false);
  assert.equal(missLog.decisions[0].cohort.riskLevel, 'high');
  console.log('ok - explicit high-risk retrieval misses remain in the recall denominator');
}

{
  const partialLog = { decisions: [], recordDecision(value) { this.decisions.push(value); } };
  const runtime = createMaidCapabilityRoutingRuntime({
    features: [...features, {
      id: 'mixed.read',
      title: '读取混合状态',
      aliases: ['读取混合状态'],
      tools: ['app.read_state', 'danger.delete'],
      riskLevel: 'medium',
      writes: true,
    }, {
      id: 'android.state.read',
      title: 'Android 状态读取',
      tools: ['app.read_state'],
      allowedPlatforms: ['android'],
      riskLevel: 'low',
      writes: false,
    }],
    toolRegistry: registry,
    permissionEvaluator: {
      evaluateTool: tool => ({ decision: tool.name === 'danger.delete' ? 'deny' : 'allow', checks: [] }),
    },
    retrievalStore: partialLog,
    logger: { debug() {} },
  });
  const request = runtime.beginRequest({ input: '读取混合状态' });
  const snapshot = runtime.prepareDecision({
    requestId: request.id,
    input: '读取混合状态',
    context: { platform: 'windows' },
  });
  runtime.observeDecision(snapshot, {
    ok: true,
    featureId: 'mixed.read',
    toolName: 'app.read_state',
    args: {},
  });
  assert.equal(partialLog.decisions[0].policyExcluded, false);
  assert.equal(partialLog.decisions[0].validSelection, true);
  console.log('ok - denying one tool does not exclude allowed tools in the same capability');
}

{
  const ambiguousFeatures = [
    ...features,
    { id: 'app.verify.alternate', title: '另一验证', tools: ['app.verify'], riskLevel: 'low', writes: false },
  ];
  const runtime = createMaidCapabilityRoutingRuntime({
    features: ambiguousFeatures,
    toolRegistry: registry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { debug() {} },
  });
  runtime.setConfig({ mode: 'bounded' });
  const request = runtime.beginRequest({ input: '看看当前状态' });
  const snapshot = runtime.prepareDecision({ requestId: request.id, input: '看看当前状态' });
  const parentPlan = runtime.observeDecision(snapshot, {
    ok: true,
    featureId: 'app.state.read',
    toolName: 'app.read_state',
    args: {},
  });
  const ambiguousVerification = runtime.authorizeVerification({
    requestId: request.id,
    parentPlan,
    verificationPlan: {
      ok: true,
      featureId: 'app.verify.typo',
      toolName: 'app.verify',
      args: {},
    },
  });
  assert.equal(ambiguousVerification.candidateSnapshotId, snapshot.id);
  assert.equal(runtime.validatePlan(ambiguousVerification).ok, false);
  console.log('ok - ambiguous verification ownership fails closed in candidate mode');
}

{
  const mutableRegistry = createAgentToolRegistry({
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { warn() {} },
  });
  mutableRegistry.register({
    name: 'app.read_state',
    schema: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
  });
  mutableRegistry.register({
    name: 'app.search_feature',
    schema: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
  });
  const runtime = createMaidCapabilityRoutingRuntime({
    features: features.filter(item => ['app.state.read', 'app.capabilities.search'].includes(item.id)),
    toolRegistry: mutableRegistry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { debug() {} },
  });
  runtime.setConfig({ mode: 'bounded' });
  const request = runtime.beginRequest({ input: '看看当前状态' });
  const snapshot = runtime.prepareDecision({ requestId: request.id, input: '看看当前状态' });
  const plan = runtime.observeDecision(snapshot, {
    ok: true,
    featureId: 'app.state.read',
    toolName: 'app.read_state',
    args: {},
  });
  mutableRegistry.register({
    name: 'app.read_state',
    schema: { type: 'object', required: ['scope'], properties: { scope: { type: 'string' } } },
    execute: async () => ({ ok: true }),
  });
  const stale = runtime.validatePlan(plan);
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'candidate_schema_stale');
  console.log('ok - Validator rejects stale candidate schema hashes before execution');
}

{
  const writes = [];
  const runtime = createMaidCapabilityRoutingRuntime({
    features,
    toolRegistry: registry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    storage: {
      getItem: () => null,
      setItem: (...args) => writes.push(args),
    },
    logger: { debug() {} },
  });
  assert.equal(runtime.getConfig().mode, 'shadow');
  const request = runtime.beginRequest({ input: '看看当前状态' });
  const snapshot = runtime.prepareDecision({
    requestId: request.id,
    input: '看看当前状态',
    configOverride: { mode: 'bounded' },
  });
  assert.equal(snapshot.mode, 'bounded');
  assert.equal(snapshot.useCandidates, true);
  assert.equal(runtime.getConfig().mode, 'shadow');
  assert.equal(writes.length, 0);
  runtime.finishRequest(request.id, { ok: true });
  console.log('ok - controlled capability previews can use bounded routing without persisting config');
}

console.log('maid-capability-routing-tests passed');

{
  // 口语化的发消息说法都要检索到 chat.send_message；改名走 profile.update 而不是新建用户，其他资源改名交给对应功能
  const retriever = createMaidCapabilityRetriever();
  const features = listAppFeatures();
  const topOf = query => retriever.retrieve(query, { features, limit: 6 })[0]?.id;
  for (const query of ['帮我给艾琳发一条消息说晚上好', '在艾琳的聊天室发个晚安', '跟艾琳说一声我今晚晚点回来', '帮我传讯息给艾琳', '转告艾琳：明天见', '向聊天室发送讯息「晚上好」']) {
    assert.equal(topOf(query), 'chat.send_message', query);
  }
  assert.notEqual(topOf('跟你说一声我明天不在'), 'chat.send_message', 'talking to the maid is not a send request');
  assert.equal(topOf('帮我发条动态'), 'moments.publish');
  for (const query of ['把我的用户名改成小明', '帮我改一下用户名称', '把角色卡「艾琳」改名叫「艾琳娜」', '把群名改成周末小组']) {
    assert.equal(topOf(query), 'profile.update', query);
  }
  assert.notEqual(topOf('修改预设名称'), 'profile.update');
  assert.notEqual(topOf('给正则规则集改名'), 'profile.update');
  assert.equal(topOf('新建一个用户叫小明'), 'user.create');
  console.log('ok - colloquial send-message and rename requests route to the right features');
}

{
  // 对待确认删除清单的修改回复（“确认，但保留乙，只删甲”）：原清单的删除功能不被高风险检查挡掉，并固定在候选里
  const { catalogFeatures, catalogRegistry } = createCatalogRoutingHarness();
  const runtime = createMaidCapabilityRoutingRuntime({
    features: catalogFeatures,
    toolRegistry: catalogRegistry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { debug() {} },
  });
  const input = '确认，但保留「批测乙」，只删甲。';
  const request = runtime.beginRequest({ input });
  const plain = runtime.prepareDecision({ requestId: request.id, input, phase: 'planner', configOverride: { mode: 'bounded' } });
  assert.equal(plain.candidateIds.has('regex.delete_many'), false, 'without a pending list the gate still applies');
  assert.equal(plain.excluded.some(item => item.id === 'regex.delete_many' && item.reason === 'risk_intent_not_explicit'), true);
  const revision = runtime.prepareDecision({
    requestId: request.id, input, phase: 'planner', configOverride: { mode: 'bounded' },
    context: { pendingActionRevision: { featureId: 'regex.delete_many', toolName: 'regex.delete_many' } },
  });
  assert.equal(revision.candidateIds.has('regex.delete_many'), true);
  assert.equal(revision.candidateRefs.find(ref => ref.id === 'regex.delete_many').reasonCodes.includes('pending_action_revision'), true);
  assert.equal(revision.candidateIds.has('script.delete_many'), false, 'only the pending list feature is released');
  runtime.finishRequest(request.id, { ok: true });
  console.log('ok - a reply revising a pending delete list keeps that delete feature available');
}
