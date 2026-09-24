import assert from 'node:assert/strict';
import { listAppFeatures } from '../../src/scripts/agent/app-feature-catalog.js';

import {
  buildMaidImportedCardClassificationMessages,
  buildMaidFeatureCatalogPrompt,
  stringifyRecentStepsForPrompt,
  compactJsonForPrompt,
  buildMaidModelPlannerFeatureList,
  buildMaidModelPlannerMessages,
  buildMaidModelReActMessages,
  createMaidImportedCardClassifier,
  createMaidModelBackedPlanner,
  createMaidModelBackedReActPlanner,
  extractMaidModelPlannerJson,
  normalizeMaidModelPlan,
  normalizeMaidModelReActDecision,
} from '../../src/scripts/agent/maid-model-planner.js';
import {
  buildMaidImageGenerationContext,
} from '../../src/scripts/agent/maid-image-generation-context.js';
import { setPromptLocale } from '../../src/scripts/i18n/prompt-locale.js';

const cloneJson = value => JSON.parse(JSON.stringify(value));

{
  setPromptLocale('en');
  const planner = buildMaidModelPlannerMessages({ input: '请查看状态', features: [] });
  const react = buildMaidModelReActMessages({ input: '请查看状态', features: [], steps: [] });
  for (const messages of [planner, react]) {
    assert.match(messages[0].content, /every user-visible response in English/);
    assert.match(messages[0].content, /internal instructions, app knowledge, tool results, or source data are written in Chinese/);
  }
  setPromptLocale('zh-CN');
  console.log('ok - English maid planner paths enforce English user-visible responses');
}

{
  const entries = Array.from({ length: 97 }, (_, index) => ({
    id: `entry-${index + 1}`,
    title: `条目-${index + 1}`,
    keys: [`key-${index + 1}`],
    disabled: index % 2 === 0,
  }));
  const messages = buildMaidImportedCardClassificationMessages({
    input: '从海贼王世界书挑出草帽一伙主要人物并建立聊天室。',
    persona: { id: 'persona-one-piece', name: '海贼王' },
    worldbook: { id: 'world-one-piece', name: '海贼王', entryCount: 97 },
    entries,
  });
  assert.match(String(messages[0].content), /character\s*\/\s*setting\s*\/\s*format\s*\/\s*rule\s*\/\s*other/);
  assert.match(String(messages[1].content), /entry-1/);
  assert.match(String(messages[1].content), /entry-97/);

  let runtimeRequest = null;
  let chatCalls = 0;
  let seenOptions = null;
  const classifier = createMaidImportedCardClassifier({
    resolveRuntimeConfig: async (request) => {
      runtimeRequest = request;
      return {
        configured: true,
        config: { provider: 'custom', model: 'gpt-test' },
        client: {
          chat: async (_messages, options) => {
            chatCalls += 1;
            seenOptions = options;
            return JSON.stringify({
              entries: entries.map(entry => ({
                entryId: entry.id,
                kind: entry.id === 'entry-1' ? 'character' : 'other',
              })),
              candidates: [{
                entryId: 'entry-1',
                name: '路飞',
                confidence: 0.99,
                reason: '草帽一伙船长',
              }],
              group: {
                enabled: true,
                name: '草帽一伙',
                memberEntryIds: ['entry-1'],
              },
            });
          },
        },
      };
    },
    logger: { warn() {}, debug() {} },
  });
  const classified = await classifier({
    input: '从海贼王世界书挑出草帽一伙主要人物并建立聊天室。',
    persona: { id: 'persona-one-piece', name: '海贼王' },
    worldbook: { id: 'world-one-piece', name: '海贼王', entryCount: 97 },
    entries,
  });
  assert.equal(runtimeRequest.taskType, 'maid_imported_card_classifier');
  assert.equal(chatCalls, 1, '人物分类必须只有一次模型调用');
  assert.equal(seenOptions.temperature, 0);
  assert.equal(classified.candidates[0].entryId, 'entry-1');
  console.log('ok - imported-card classifier receives the complete compact index in one constrained call');
}

{
  const featureList = buildMaidModelPlannerFeatureList([
    {
      id: 'worldbook.open',
      title: '打开世界书',
      tools: ['app.open_panel'],
      panel: 'worldbook',
      aliases: ['世界书'],
      uiPath: ['聊天室右上角菜单', '世界书'],
    },
  ]);
  assert.match(featureList, /worldbook\.open/);
  assert.match(featureList, /app\.open_panel/);

  const writeFeatureList = buildMaidModelPlannerFeatureList([
    {
      id: 'worldbook.bind_session',
      title: '绑定世界书',
      tools: ['worldbook.bind_session'],
      writes: true,
      riskLevel: 'medium',
    },
  ]);
  assert.match(writeFeatureList, /writes: true/);
  assert.match(writeFeatureList, /risk: medium/);

  const messages = buildMaidModelPlannerMessages({
    input: '世界书在哪里',
    context: { sessionId: 'A', uiMode: 'chat' },
    features: [
      {
        id: 'worldbook.open',
        title: '打开世界书',
        aliases: ['世界书'],
        tools: ['app.open_panel'],
        panel: 'worldbook',
      },
    ],
  });
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /严格 JSON/);
  assert.match(messages[0].content, /## 女仆人格/);
  assert.match(messages[0].content, /自然生成/);
  assert.match(messages[0].content, /优先选择非破坏性做法/);
  assert.match(messages[0].content, /删除、覆盖、替换/);
  assert.match(messages[0].content, /APP 确认弹窗/);
  assert.match(messages[0].content, /只要求查询、查看、检查或确认/);
  assert.match(messages[0].content, /多个结构化资源的只读比较不需要 todo/);
  assert.match(messages[0].content, /继续上一件未完成/);
  assert.match(messages[0].content, /可继续: 是/);
  assert.match(messages[0].content, /worldbook\.update_entries/);
  assert.match(messages[0].content, /1-3 个条目/);
  assert.match(messages[0].content, /完整、具体、可直接执行的 JSON/);
  assert.match(messages[0].content, /__keep_existing/);
  assert.match(messages[1].content, /世界书在哪里/);
  assert.doesNotMatch(messages[1].content, /相关功能检索/, '检索结果已体现在功能目录里，不再重复注入');
  assert.match(messages[0].content, /worldbook\.open/);
  console.log('ok - maid model planner builds constrained prompt messages');
}

{
  // 分层目录：排名前 4 的功能给完整参数（放在用户消息开头）；索引列出全部功能且顺序固定，属于不变的系统提示
  const all = listAppFeatures();
  const ranked = ['regex.list', 'regex.upsert_rules', 'regex.toggle', 'regex.delete_many', 'regex.open', 'preset.list', 'app.capabilities.search']
    .map(id => all.find(feature => feature.id === id)).filter(Boolean);
  const catalog = buildMaidFeatureCatalogPrompt({ features: ranked, featureIndex: all });
  assert.deepEqual(catalog.detailedIds, ['regex.list', 'regex.upsert_rules', 'regex.toggle', 'regex.delete_many', 'app.capabilities.search']);
  assert.doesNotMatch(catalog.detailText, /- id: regex\.open/, '排名第 5 的功能不给详情');
  assert.doesNotMatch(catalog.detailText, /aliases:/, '详情不带检索别名');
  assert.match(catalog.staticText, /^- regex\.open: /m);
  assert.match(catalog.staticText, /^- regex\.list: /m, '索引包含全部功能，不随候选变化');
  assert.equal((catalog.staticText.match(/^- /gm) || []).length, all.filter(feature => feature.tools?.length).length, 'every feature with tools is indexed');
  assert.match(catalog.staticText, /app\.read_feature_doc/);
  const messages = buildMaidModelPlannerMessages({ input: '看看正则', features: ranked, featureIndex: all });
  const other = buildMaidModelPlannerMessages({ input: '帮我新建一个角色卡', features: all.filter(f => /^persona\./.test(f.id)), featureIndex: all });
  assert.equal(messages[0].content, other[0].content, 'the system prompt is identical across requests so provider prompt caching can hit');
  assert.match(messages.at(-1).content, /^<app_features>\n- id: regex\.list/, 'candidate details lead the dynamic user message');
  const react = buildMaidModelReActMessages({ input: '看看正则', features: ranked, featureIndex: all, steps: [] });
  const reactOther = buildMaidModelReActMessages({ input: '别的', features: all.slice(0, 3), featureIndex: all, steps: [{ index: 1, toolName: 'regex.list', status: 'succeeded', output: {} }] });
  assert.equal(react[0].content, reactOther[0].content, 'ReAct system prompt is stable across steps');
  const fullCatalog = buildMaidModelPlannerFeatureList(all);
  assert.ok(messages[0].content.length + catalog.detailText.length < fullCatalog.length, 'layered prompt stays smaller than the old full catalog');
  console.log('ok - feature catalog details only the top-ranked features and indexes the rest');
}

{
  // 一次很大的读取不能挤掉最新一步：刚完成的写入与读回必须完整可见，否则模型会重复写入
  const bigRead = { index: 1, toolName: 'regex.list', args: { includeRules: true }, status: 'succeeded', summary: 'listed regex: 48 set(s)', output: { sets: Array.from({ length: 48 }, (_, i) => ({ id: `set-${i}`, name: `规则集${i}`, rules: Array.from({ length: 10 }, (__, j) => ({ id: `r-${i}-${j}`, findRegex: 'x'.repeat(40) })) })) } };
  const write = { index: 2, toolName: 'regex.upsert_rules', args: { newSetName: '计时测试甲' }, status: 'succeeded', summary: 'regex rules write completed; 1 succeeded', output: { ok: true, target: 'set-new', results: [{ name: '替换', status: 'succeeded' }] } };
  const readBack = { index: 3, toolName: 'regex.list', args: { container: 'set-new', includeRules: true }, status: 'succeeded', summary: 'listed regex: 1 set(s)', output: { sets: [{ id: 'set-new', name: '计时测试甲', rules: [{ id: 'r1', findRegex: '测试丙' }] }] } };
  const text = stringifyRecentStepsForPrompt([bigRead, write, readBack], 12000);
  assert.ok(text.length <= 12200, `bounded: ${text.length}`);
  assert.match(text, /regex rules write completed; 1 succeeded/, 'the write stays visible');
  assert.match(text, /"container":"set-new"/);
  assert.match(text, /测试丙/, 'the newest observation is complete');
  assert.ok(text.indexOf('regex.upsert_rules') > text.indexOf('规则集0'), 'chronological order is kept');
  const many = stringifyRecentStepsForPrompt(Array.from({ length: 6 }, (_, i) => ({ ...bigRead, index: i + 1 })), 12000);
  assert.ok(many.length <= 12400);
  assert.match(many, /"index":6/);
  // 只有一步时可用满预算：48 个规则集的精简清单不该被缩到 30 项
  const single = stringifyRecentStepsForPrompt([{ index: 1, toolName: 'regex.list', status: 'succeeded', output: { sets: Array.from({ length: 48 }, (_, i) => ({ id: `re-set-${i}-abcdef`, name: `规则集名称${i}`, enabled: true, activeNow: false, bind: '绑定预设：某个预设', ruleCount: 3 })) } }], 12000);
  assert.doesNotMatch(single, /项未显示/);
  assert.match(single, /规则集名称47/);
  console.log('ok - recent step observations give the newest step its budget first');
}

{
  // 同参数、同结果的重复读取：旧的一次只留指向最新一次的短句；结果变了（中间有写入）或是写入工具时照常完整显示
  const listed = { sets: [{ id: 'a', name: '规则集甲' }, { id: 'b', name: '规则集乙' }] };
  const read = index => ({ index, toolName: 'regex.list', args: { includeRules: false }, status: 'succeeded', output: listed });
  const text = stringifyRecentStepsForPrompt([read(1), read(2), read(3)], 12000);
  assert.equal((text.match(/规则集甲/g) || []).length, 1, 'the data appears once');
  assert.match(text, /"index": 1, "toolName": "regex\.list", "status": "succeeded", "output": "与第 3 步的参数和结果完全相同/);
  assert.match(text, /"index": 2,[^\n]*与第 3 步/);
  const changed = stringifyRecentStepsForPrompt([read(1), { ...read(2), output: { sets: [{ id: 'a', name: '规则集甲' }] } }], 12000);
  assert.doesNotMatch(changed, /重复读取/, 'a changed result is a new observation');
  const writes = stringifyRecentStepsForPrompt([1, 2].map(index => ({ index, toolName: 'regex.toggle', args: { id: 'a' }, status: 'succeeded', output: { ok: true } })), 12000);
  assert.doesNotMatch(writes, /重复读取/, 'repeated writes are never folded');
  console.log('ok - identical repeated reads collapse to a pointer at the newest copy');
}

{
  // 超长观察按结构精简：数量与顶层字段保留，长数组注明省略数，结果仍是可读的 JSON 形状
  const value = { ok: true, counts: { openai: 130 }, presets: { openai: { count: 130, presets: Array.from({ length: 130 }, (_, i) => ({ id: `p-${i}`, name: `预设${i}`, note: 'x'.repeat(500) })) } } };
  const text = compactJsonForPrompt(value, 3000);
  assert.ok(text.length <= 3000, `bounded: ${text.length}`);
  assert.match(text, /"openai":130/);
  assert.match(text, /"count":130/);
  assert.match(text, /还有 \d+ 项未显示/);
  assert.doesNotThrow(() => JSON.parse(text), 'still valid JSON when shrinking suffices');
  assert.equal(compactJsonForPrompt({ a: 1 }, 100), JSON.stringify({ a: 1 }));
  // 能放下多少就保留多少：不应一刀缩到很少的几项
  const sets = { sets: Array.from({ length: 48 }, (_, i) => ({ id: `re-set-${i}-abcdef`, name: `规则集名称${i}`, ruleCount: 3 })) };
  const fitted = compactJsonForPrompt(sets, Math.floor(JSON.stringify(sets).length * 0.8));
  const kept = (fitted.match(/规则集名称/g) || []).length;
  assert.ok(kept >= 35, `keeps as many items as fit (${kept})`);
  console.log('ok - oversized observations shrink by structure and keep counts visible');
}

{
  const messages = buildMaidModelPlannerMessages({
    input: '未知入口',
    maidPrompt: '自定义女仆 system prompt',
    features: [],
  });
  assert.match(messages[0].content, /自定义女仆 system prompt/);
  assert.match(messages[0].content, /不能改变上述工具和安全限制/);
  assert.match(messages[0].content, /危险操作包括/);
  console.log('ok - maid model planner includes editable prompt without replacing safety constraints');
}

{
  const messages = buildMaidModelPlannerMessages({
    input: '继续刚才那个角色卡',
    context: { sessionId: 's1' },
    conversationContext: {
      historyText: '- 用户: 创建角色卡 A\n  工具: persona.create\n  结果: 已完成',
      memoryText: '| 1 | 摘要 |\n| 内容 | 用户创建了角色卡 A。 |',
    },
  });
  assert.match(messages[0].content, /历史上下文和记忆表格/);
  assert.match(messages[1].content, /<maid_memory today="\d{4}-\d{2}-\d{2}">\n\| 1 \| 摘要/, 'memory is wrapped and dated');
  assert.match(messages[1].content, /<\/maid_memory>\n<maid_history>/);
  assert.match(messages[0].content, /仅供参考/);
  assert.match(messages[0].content, /先用工具重新读取/, 'changeable app state must be re-read');
  assert.match(messages[1].content, /用户创建了角色卡 A/);
  assert.match(messages[1].content, /<\/maid_history>/);
  assert.match(messages[1].content, /persona\.create/);
  console.log('ok - maid model planner injects history and memory context');
}

{
  const messages = buildMaidModelPlannerMessages({
    input: '这张图里是什么？',
    context: {
      maidAttachments: [{ kind: 'image', url: 'data:image/png;base64,abc', name: 'screen.png' }],
    },
    features: [],
  });
  assert.equal(Array.isArray(messages[1].content), true);
  assert.equal(messages[1].content[0].type, 'text');
  assert.match(messages[1].content[0].text, /用户附图/);
  assert.equal(messages[1].content[1].type, 'image_url');
  assert.equal(messages[1].content[1].image_url.url, 'data:image/png;base64,abc');
  console.log('ok - maid model planner includes image attachments as multimodal parts');
}

{
  const parsed = extractMaidModelPlannerJson('```json\n{"ok":true,"toolName":"app.open_panel"}\n```');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.toolName, 'app.open_panel');

  const embedded = extractMaidModelPlannerJson('plan: {"ok":false,"reason":"unsupported_intent"} done');
  assert.equal(embedded.ok, false);

  const toolWithFencedContent = extractMaidModelPlannerJson([
    'I will update one worldbook entry.',
    '{"ok":true,"action":"tool","toolName":"worldbook.update_entries","featureId":"worldbook.update_entries","args":{"name":"W","updates":[{"entryTitle":"A","content":"```yaml\\nname: \\"A\\"\\nbackground: \\"kept\\"\\n```"}]},"response":"更新 A"}',
  ].join('\n\n'));
  assert.equal(toolWithFencedContent.ok, true);
  assert.equal(toolWithFencedContent.toolName, 'worldbook.update_entries');
  assert.match(toolWithFencedContent.args.updates[0].content, /```yaml/);
  console.log('ok - maid model planner extracts JSON from model text');
}

{
  const messages = buildMaidModelReActMessages({
    input: '女王最后回了我什么？',
    context: { sessionId: 's1', uiMode: 'chat' },
    features: [{
      id: 'app.resource.read',
      title: '读取 APP 结构化资源',
      tools: ['app.read_resource'],
      argsHint: 'resource/sessionName 可选',
    }],
    steps: [{
      toolName: 'app.read_resource',
      status: 'succeeded',
      output: { resource: 'chat', messages: [{ role: 'assistant', rawOriginal: '晚上好。' }] },
    }],
  });
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /ReAct 控制器/);
  assert.match(messages[0].content, /不要输出思考过程/);
  assert.match(messages[0].content, /温柔、清楚、直接/);
  assert.match(messages[0].content, /优先选择非破坏性做法/);
  assert.match(messages[0].content, /未确认时跳过/);
  assert.match(messages[0].content, /只要求查询、查看、检查或确认/);
  assert.match(messages[0].content, /write_intent_required/);
  assert.match(messages[0].content, /一次成功读取已经返回用户要求的字段时，立即 final/);
  assert.match(messages[0].content, /todo_unchanged/);
  assert.match(messages[0].content, /清单状态实际变化时/);
  assert.match(messages[0].content, /多个结构化资源的只读比较不需要 todo/);
  assert.match(messages[0].content, /拿到按钮 ref 后.*app\.ui\.click.*ui\.click_element/);
  assert.match(messages[0].content, /最终回答前必须/);
  assert.match(messages[0].content, /继续提示/);
  assert.match(messages[0].content, /worldbook\.update_entries/);
  assert.match(messages[0].content, /完整、具体、可直接执行的 JSON/);
  assert.match(messages[1].content, /已执行步骤与观察结果/);
  assert.match(messages[1].content, /晚上好/);
  console.log('ok - maid model react planner builds observation prompt messages');
}

{
  const steps = [
    {
      toolName: 'app.read_resource',
      status: 'succeeded',
      args: { resource: 'persona', name: '海贼王', include: ['associations'] },
      summary: 'read resource persona',
      output: {
        resource: 'persona',
        includedFields: ['associations'],
        items: [{
          name: '海贼王',
          associations: { worldbookId: '海贼王', worldbookEnabled: true },
        }],
      },
    },
    {
      toolName: 'worldbook.read',
      status: 'succeeded',
      args: { name: '海贼王' },
      summary: 'read worldbook 海贼王 (50 entries)',
      output: {
        name: '海贼王',
        entryCount: 97,
        entries: [
          { title: '角色设定' },
          { title: '地图' },
          { title: '格式要求' },
          { title: '世界观' },
        ],
      },
    },
    ...Array.from({ length: 4 }, (_, index) => ({
      toolName: 'app.read_resource',
      status: 'succeeded',
      args: { resource: 'persona', name: `后续角色${index + 1}`, include: ['associations'] },
      summary: 'read resource persona',
      output: {
        resource: 'persona',
        includedFields: ['associations'],
        items: [{ name: `后续角色${index + 1}`, associations: {} }],
      },
    })),
  ];
  const messages = buildMaidModelReActMessages({
    input: '分别读取多张角色卡的 associations，再读取对应世界书并汇总。',
    features: [],
    steps,
  });
  const system = messages[0].content;
  const user = messages[1].content;
  assert.match(system, /成功读取账本.*相同工具与参数/);
  assert.match(user, /成功读取账本/);
  assert.match(user, /"name":\s*"海贼王"/);
  assert.match(user, /"worldbookId":\s*"海贼王"/);
  assert.match(user, /角色设定.*地图.*格式要求/s);
  assert.doesNotMatch(user, /"titles":[^\n]*世界观/);
  console.log('ok - ReAct compact read ledger preserves older targets and required facts without replaying full outputs');
}

{
  const messages = buildMaidModelReActMessages({
    input: '继续看这张图',
    context: {
      maidAttachments: [{ kind: 'image', url: 'data:image/jpeg;base64,abc', name: 'photo.jpg' }],
    },
    features: [],
    steps: [],
  });
  assert.equal(Array.isArray(messages[1].content), true);
  assert.equal(messages[1].content[1].type, 'image_url');
  console.log('ok - maid model react planner keeps image attachments across ReAct decisions');
}

{
  const finalDecision = normalizeMaidModelReActDecision({
    ok: true,
    action: 'final',
    message: '精灵女王最后回复了「晚上好」。',
  });
  assert.equal(finalDecision.ok, true);
  assert.equal(finalDecision.action, 'final');
  assert.match(finalDecision.message, /晚上好/);

  const toolDecision = normalizeMaidModelReActDecision({
    ok: true,
    action: 'tool',
    toolName: 'app.read_resource',
    args: { resource: 'chat', sessionName: '精灵女王' },
    featureId: 'app.resource.read',
  });
  assert.equal(toolDecision.ok, true);
  assert.equal(toolDecision.action, 'tool');
  assert.equal(toolDecision.toolName, 'app.read_resource');

  const denied = normalizeMaidModelReActDecision({
    ok: true,
    action: 'tool',
    toolName: 'media.fetch_image',
    args: { url: 'https://example.com/a.png' },
    featureId: 'app.resource.read',
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'tool_not_allowed');

  const directImage = normalizeMaidModelReActDecision({
    ok: true,
    action: 'tool',
    toolName: 'media.generate_image',
    args: {
      prompt: '1girl, cen_xia',
      subject: '岑夏',
      subjectAliases: ['cen_xia'],
      target: '岑夏',
      purpose: 'avatar',
      appearance: 'silver hair',
      outfit: 'navy uniform',
      style: 'anime',
      targetAspectRatio: '1:1',
    },
    featureId: 'media.generate_image',
  });
  assert.equal(directImage.ok, true);
  assert.equal(directImage.featureId, 'media.generate_image');
  console.log('ok - maid model react planner validates final and tool decisions');
}

{
  const plan = normalizeMaidModelPlan({
    ok: true,
    toolName: 'app.open_panel',
    args: { panel: 'worldbook' },
    featureId: 'worldbook.open',
    response: '我来打开世界书。',
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.toolName, 'app.open_panel');
  assert.equal(plan.args.panel, 'worldbook');
  assert.equal(plan.response, '我来打开世界书。');

  const guidePlan = normalizeMaidModelPlan({
    ok: true,
    toolName: 'guide.start_flow',
    args: { flowId: 'setup-api' },
    featureId: 'maid.onboarding',
    response: '我来带主人完成配置。',
  });
  assert.equal(guidePlan.ok, false);
  assert.equal(guidePlan.reason, 'feature_not_found');

  const noResponse = normalizeMaidModelPlan({
    ok: true,
    toolName: 'app.open_panel',
    args: { panel: 'worldbook' },
    featureId: 'worldbook.open',
  });
  assert.equal(noResponse.ok, true);
  assert.equal(noResponse.response, '');

  const denied = normalizeMaidModelPlan({
    ok: true,
    toolName: 'media.fetch_image',
    featureId: 'worldbook.open',
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'tool_not_allowed');
  assert.ok(denied.message.includes('media.fetch_image'));
  console.log('ok - maid model planner validates feature and tool allowlist');
}

{
  // featureId 与 toolName 混搭：工具归属唯一时自动纠偏 feature
  const remapped = normalizeMaidModelPlan({
    ok: true,
    toolName: 'ui.click_element',
    args: { ref: 'agent-center:btn-3' },
    featureId: 'agent.center.open',
  });
  assert.equal(remapped.ok, true);
  assert.equal(remapped.featureId, 'app.ui.click');
  assert.equal(remapped.toolName, 'ui.click_element');

  // featureId 不存在但工具归属唯一：同样纠偏
  const invented = normalizeMaidModelPlan({
    ok: true,
    toolName: 'ui.click_element',
    args: { label: '失败' },
    featureId: 'agent.center.filter',
  });
  assert.equal(invented.ok, true);
  assert.equal(invented.featureId, 'app.ui.click');

  // inspect 只归属于可见界面读取；模型幻觉近似 featureId 时可按唯一工具归属纠偏
  const hallucinatedInspect = normalizeMaidModelPlan({
    ok: true,
    toolName: 'app.ui.inspect',
    args: {},
    featureId: 'app.visible_panel_summary.read',
  });
  assert.equal(hallucinatedInspect.ok, true);
  assert.equal(hallucinatedInspect.featureId, 'app.visible_panel.read');
  assert.equal(hallucinatedInspect.toolName, 'app.ui.inspect');

  // 工具多归属且 featureId 不存在：无法纠偏，拒绝并带上模型选择
  const ambiguous = normalizeMaidModelPlan({
    ok: true,
    toolName: 'media.fetch_image',
    featureId: 'no.such.feature',
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, 'feature_not_found');
  assert.ok(ambiguous.message.includes('no.such.feature'));
  console.log('ok - maid model planner remaps mismatched feature by unique tool');
}

{
  const rejected = normalizeMaidModelPlan({
    ok: true,
    toolName: 'outside.tool',
    featureId: 'outside.feature',
  }, {
    candidateMode: true,
    candidateSnapshotId: 'candidate-1',
    features: [{
      id: 'app.state.read',
      title: '读取状态',
      tools: ['app.read_state'],
      riskLevel: 'low',
      writes: false,
    }],
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.candidateViolation, true);
  assert.equal(rejected.selectedCapabilityId, 'outside.feature');
  assert.equal(rejected.selectedToolName, 'outside.tool');
  assert.equal(rejected.candidateSnapshotId, 'candidate-1');
  console.log('ok - candidate-mode rejections retain compact attempted-selection metrics');
}

{
  let runtimeCalls = 0;
  let chatCalls = 0;
  const injected = [];
  const chatOptions = [];
  const planner = createMaidModelBackedPlanner({
    resolveRuntimeConfig: async () => {
      runtimeCalls += 1;
      return {
        client: {
          chat: async (messages, options) => {
            chatCalls += 1;
            chatOptions.push(options);
            return JSON.stringify({
              ok: true,
              toolName: 'app.open_panel',
              args: { panel: 'worldbook' },
              featureId: 'worldbook.open',
              title: '打开世界书',
              response: '我来打开世界书。',
            });
          },
        },
      };
    },
    getConversationContext: () => ({
      historyText: '- 用户: 打开设置',
      memoryText: '| 内容 | 用户正在测试女仆 |',
      tokenCount: 18,
    }),
    onContextInjected: payload => injected.push(payload),
  });
  const plan = await planner('打开世界书');
  assert.equal(plan.ok, true);
  assert.equal(plan.toolName, 'app.open_panel');
  assert.equal(runtimeCalls, 1);
  assert.equal(chatCalls, 1);
  assert.equal(chatOptions[0].maxTokens, 8000);
  assert.equal(plan.source, 'model_planner');
  assert.equal(injected.length, 1);
  assert.equal(injected[0].conversationContext.tokenCount, 18);
  console.log('ok - maid model planner asks the model even for locally recognizable intents');
}

{
  const debugSnapshots = [];
  const planner = createMaidModelBackedPlanner({
    resolveRuntimeConfig: async () => ({
      maidPrompt: '用轻快语气回复',
      client: {
        chat: async () => JSON.stringify({
          ok: true,
          toolName: 'app.open_panel',
          args: { panel: 'variables' },
          featureId: 'variables.open',
          title: '打开变量',
          response: '我来打开变量。',
        }),
      },
    }),
    isConfigReady: () => true,
    onDebugSnapshot: snapshot => debugSnapshots.push(snapshot),
  });
  const plan = await planner('帮我处理高级资料入口 xyz');
  assert.equal(plan.ok, true);
  assert.equal(plan.source, 'model_planner');
  assert.equal(plan.toolName, 'app.open_panel');
  assert.equal(plan.args.panel, 'variables');
  assert.equal(debugSnapshots.length, 1);
  assert.equal(debugSnapshots[0].source, 'maid_model_planner');
  assert.match(debugSnapshots[0].messages[0].content, /用轻快语气回复/);
  assert.match(debugSnapshots[0].messages[1].content, /高级资料入口/);
  assert.match(debugSnapshots[0].responseText, /variables\.open/);
  console.log('ok - maid model planner uses configured client as the tool planner');
}

{
  let contextBuilds = 0;
  const injected = [];
  const getConversationContext = () => {
    contextBuilds += 1;
    return {
      maidContextVersion: 'maid-context-test-v1',
      historyText: `冻结历史 ${contextBuilds}`,
      memoryText: `冻结记忆 ${contextBuilds}`,
      tokenCount: 42,
    };
  };
  const runtime = {
    client: {
      chat: async messages => (
        messages[0].content.includes('ReAct 控制器')
          ? JSON.stringify({ ok: true, action: 'final', message: '完成' })
          : JSON.stringify({
              ok: true,
              toolName: 'app.open_panel',
              args: { panel: 'worldbook' },
              featureId: 'worldbook.open',
            })
      ),
    },
  };
  const planner = createMaidModelBackedPlanner({
    features: [{
      id: 'worldbook.open',
      title: '打开世界书',
      aliases: ['世界书'],
      tools: ['app.open_panel'],
      panel: 'worldbook',
    }],
    resolveRuntimeConfig: async () => runtime,
    getConversationContext,
    onContextInjected: payload => injected.push(payload.conversationContext),
  });
  const reactPlanner = createMaidModelBackedReActPlanner({
    features: [{
      id: 'worldbook.open',
      title: '打开世界书',
      aliases: ['世界书'],
      tools: ['app.open_panel'],
      panel: 'worldbook',
    }],
    resolveRuntimeConfig: async () => runtime,
    getConversationContext,
    onContextInjected: payload => injected.push(payload.conversationContext),
  });
  const context = { maidConversationContextRef: { current: null } };
  const plan = await planner('打开世界书', context);
  const decision = await reactPlanner('打开世界书', {
    ...context,
    maidReactSteps: [{ toolName: plan.toolName, status: 'succeeded', output: { ok: true } }],
  });
  assert.equal(plan.ok, true);
  assert.equal(decision.action, 'final');
  assert.equal(contextBuilds, 1, '同一 Maid Run 的 Planner/ReAct 只能构建一次上下文快照');
  assert.equal(injected.length, 2);
  assert.equal(injected[0], injected[1], 'Planner/ReAct 必须复用同一冻结对象');
  console.log('ok - maid planner and ReAct share one frozen conversation context per run');
}

{
  // Phase B 计量：client 经 options.onProviderUsage 上报 usage → planner 经 context.onModelUsage 冒泡（含延迟）
  const usageEntries = [];
  const planner = createMaidModelBackedPlanner({
    resolveRuntimeConfig: async () => ({
      client: {
        chat: async (messages, options) => {
          options?.onProviderUsage?.({ provider: 'deepseek', model: 'v4-pro', promptTokens: 800, completionTokens: 120, totalTokens: 920, finishReason: 'stop' });
          return JSON.stringify({ ok: true, toolName: 'app.open_panel', args: { panel: 'variables' }, featureId: 'variables.open' });
        },
      },
    }),
    isConfigReady: () => true,
  });
  const context = { onModelUsage: (u) => usageEntries.push(u) };
  const plan = await planner('打开变量面板', context);
  assert.equal(plan.ok, true);
  assert.equal(usageEntries.length, 1);
  assert.equal(usageEntries[0].provider, 'deepseek');
  assert.equal(usageEntries[0].promptTokens, 800);
  assert.equal(usageEntries[0].completionTokens, 120);
  assert.equal(usageEntries[0].modelCallCount, 1);
  assert.equal(usageEntries[0].degraded, false);
  assert.equal(typeof usageEntries[0].latencyMs, 'number');
  console.log('ok - planner bubbles provider usage through context.onModelUsage');
}

{
  const context = {
    capabilitySnapshot: {
      id: 'fallback-cohort-snapshot',
      useCandidates: false,
      cohort: {},
    },
  };
  // 计量：主档失败走 fallback 时 usage 归 fallback 且 degraded=true
  const usageEntries = [];
  context.onModelUsage = (u) => usageEntries.push(u);
  const planner = createMaidModelBackedPlanner({
    resolveRuntimeConfig: async () => ({
      profileId: 'primary-profile',
      fallbackProfileId: 'fallback-profile',
      config: { provider: 'openai', model: 'primary-model' },
      fallbackConfig: { provider: 'deepseek', model: 'fallback-model' },
      client: { chat: async () => { throw new Error('primary offline'); } },
      fallbackClient: {
        chat: async (messages, options) => {
          options?.onProviderUsage?.({ provider: 'deepseek', model: 'fallback-model', promptTokens: 500, completionTokens: 90, totalTokens: 590 });
          return JSON.stringify({
            ok: true,
            toolName: 'app.open_panel',
            args: { panel: 'worldbook' },
            featureId: 'worldbook.open',
          });
        },
      },
    }),
    logger: { warn() {}, debug() {} },
  });
  const plan = await planner('打开世界书', context);
  assert.equal(plan.ok, true);
  assert.equal(context.capabilitySnapshot.cohort.profileId, 'fallback-profile');
  assert.equal(context.capabilitySnapshot.cohort.provider, 'deepseek');
  assert.equal(context.capabilitySnapshot.cohort.model, 'fallback-model');
  assert.equal(usageEntries.length, 2);
  assert.equal(usageEntries[0].model, 'primary-model');
  assert.equal(usageEntries[0].outcome, 'provider_request_failed');
  assert.equal(usageEntries[1].provider, 'deepseek');
  assert.equal(usageEntries[1].promptTokens, 500);
  assert.equal(usageEntries.reduce((sum, entry) => sum + entry.modelCallCount, 0), 2);
  assert.equal(usageEntries[1].degraded, true);
  console.log('ok - fallback model decisions are attributed to the actual cohort');
}

{
  const usageEntries = [];
  const planner = createMaidModelBackedPlanner({
    resolveRuntimeConfig: async () => ({
      client: { chat: async () => { throw new Error('primary offline'); } },
    }),
    logger: { warn() {}, debug() {} },
  });
  const plan = await planner('打开世界书', {
    onModelUsage: usage => usageEntries.push(usage),
  });
  assert.equal(plan.ok, false);
  assert.equal(usageEntries.length, 1);
  assert.equal(usageEntries[0].modelCallCount, 1);
  assert.equal(usageEntries[0].degraded, false);
  assert.equal(typeof usageEntries[0].latencyMs, 'number');
  console.log('ok - failed model calls still report local call count and latency');
}

{
  const planner = createMaidModelBackedPlanner({
    resolveRuntimeConfig: async () => ({ config: {} }),
    isConfigReady: () => false,
  });
  const plan = await planner('打开世界书');
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'maid_api_not_configured');
  console.log('ok - maid model planner does not use local fallback when API is not configured');
}

{
  const planner = createMaidModelBackedPlanner({
    resolveRuntimeConfig: async () => ({
      client: {
        chat: async () => JSON.stringify({
          ok: true,
          toolName: 'media.fetch_image',
          args: { url: 'https://example.com/a.png' },
          featureId: 'worldbook.open',
          response: 'bad plan',
        }),
      },
    }),
  });
  const plan = await planner('打开世界书');
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'tool_not_allowed');
  console.log('ok - maid model planner rejects invalid model plans without local fallback');
}

{
  const debugSnapshots = [];
  const chatOptions = [];
  const reactPlanner = createMaidModelBackedReActPlanner({
    resolveRuntimeConfig: async () => ({
      maidPrompt: '温柔一点',
      client: {
        chat: async (messages, options) => {
          chatOptions.push(options);
          return JSON.stringify({
            ok: true,
            action: 'final',
            message: '精灵女王最后回复了「晚上好」。',
          });
        },
      },
    }),
    onDebugSnapshot: snapshot => debugSnapshots.push(snapshot),
  });
  const decision = await reactPlanner('女王最后回了我什么？', {
    sessionId: 's1',
    maidReactSteps: [{
      toolName: 'app.read_resource',
      status: 'succeeded',
      output: { messages: [{ rawOriginal: '晚上好。' }] },
    }],
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.action, 'final');
  assert.match(decision.message, /晚上好/);
  assert.equal(chatOptions[0].maxTokens, 12000);
  assert.equal(debugSnapshots.length, 1);
  assert.equal(debugSnapshots[0].source, 'maid_model_react');
  assert.match(debugSnapshots[0].messages[0].content, /温柔一点/);
  console.log('ok - maid model react planner calls configured model and returns final answer');
}

{
  let fallbackCalls = 0;
  const reactPlanner = createMaidModelBackedReActPlanner({
    resolveRuntimeConfig: async () => ({
      client: { chat: async () => { throw new Error('primary unavailable'); } },
      fallbackClient: { chat: async () => { fallbackCalls += 1; return '{}'; } },
      fallbackConfig: { provider: 'deepseek', model: 'deepseek-chat' },
    }),
    logger: { warn: () => {}, debug: () => {} },
  });
  const decision = await reactPlanner('看看截图', {
    maidAttachments: [{ kind: 'image', url: 'data:image/png;base64,AAAA', name: 'capture.png' }],
    maidReactSteps: [],
  });
  assert.equal(decision.ok, false);
  assert.equal(fallbackCalls, 0, 'text-only fallback must not receive screenshot image parts');
  console.log('ok - maid model react planner suppresses text-only fallback for screenshots');
}

{
  const reactPlanner = createMaidModelBackedReActPlanner({
    resolveRuntimeConfig: async () => ({
      client: {
        chat: async () => '主人，我看到了！这本世界书里一共有 5 个条目，其中 entry-1 到 entry-3 是念初相关设定。',
      },
    }),
  });
  const decision = await reactPlanner('在异世界世界书里面', {
    sessionId: 's1',
    maidReactSteps: [{
      toolName: 'worldbook.read',
      status: 'succeeded',
      output: { entryCount: 5 },
    }],
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.action, 'final');
  assert.equal(decision.source, 'model_react_text_fallback');
  assert.match(decision.message, /5 个条目/);
  console.log('ok - maid model react planner treats non-JSON natural text as final answer');
}

{
  const reactPlanner = createMaidModelBackedReActPlanner({
    resolveRuntimeConfig: async () => ({
      client: {
        chat: async () => '我来执行：{"ok":true,"action":"tool","toolName":"worldbook.update_entries","featureId":"worldbook.update_entries","args":{"name":"W","updates":[{"entryTitle":"A","content":"截断',
      },
    }),
  });
  const decision = await reactPlanner('继续替换', {
    maidReactSteps: [{ toolName: 'worldbook.read', status: 'succeeded', output: { entryCount: 3 } }],
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'invalid_model_react_decision');
  assert.match(decision.message, /不完整的工具决策/);
  console.log('ok - maid model react planner rejects incomplete tool JSON as final text');
}

{
  const features = [{
    id: 'session.create',
    title: '创建聊天室',
    tools: ['session.create', 'session.list'],
    argsHint: 'name 创建单个聊天室',
    panel: 'session',
    aliases: ['创建聊天室'],
    uiPath: ['顶部 +', '添加'],
  }];
  const yaml = buildMaidModelPlannerFeatureList(features);
  assert.match(yaml, /^- id: session\.create$/m);
  assert.match(yaml, /^  title: 创建聊天室$/m);
  assert.match(yaml, /^  tools: \[session\.create, session\.list\]$/m);
  assert.match(yaml, /^  path: 顶部 \+ -> 添加$/m);
  const messages = buildMaidModelPlannerMessages({ input: '测试', features });
  const user = messages.at(-1).content;
  assert.match(user, /<app_features>\n- id: session\.create/);
  assert.match(user, /<\/app_features>/);
  console.log('ok - 功能目录以 YAML 列表呈现并用 app_features 标签分隔');
}

{
  const messages = buildMaidModelPlannerMessages({
    input: '查看最近任务',
  });
  const reactMessages = buildMaidModelReActMessages({
    input: '查看最近任务',
    steps: [],
  });
  for (const system of [messages[0].content, reactMessages[0].content]) {
    assert.match(system, /APP 存在由本地界面直接处理的内建新手任务/);
    assert.doesNotMatch(system, /maid\.onboarding|女仆新手引导|guide\.start_flow|setup-api|add-friend|first-chat|meet-maid/);
    assert.match(system, /默认在后台执行/);
    assert.match(system, /只展示最终的主要结果/);
    assert.match(system, /查询、查看、检查.*不等于要求打开界面/);
    assert.match(system, /triggerReply:true/);
    assert.match(system, /必须进入目标聊天室/);
  }
  console.log('ok - model planner separates local onboarding from background-first presentation policy');
}

{
  const features = [{
    id: 'app.state.read',
    title: '读取状态',
    aliases: ['看看状态'],
    tools: ['app.read_state'],
    argsHint: '无参数',
  }, {
    id: 'app.resource.read',
    title: '读取资源',
    aliases: ['看看资源'],
    tools: ['app.read_resource'],
  }];
  let capturedMessages = null;
  const planner = createMaidModelBackedPlanner({
    features,
    resolveRuntimeConfig: async () => ({
      profileId: 'weak-profile',
      config: { provider: 'custom', model: 'weak-model' },
      client: {
        chat: async (messages) => {
          capturedMessages = cloneJson(messages);
          return JSON.stringify({
            ok: true,
            featureId: 'app.state.read',
            toolName: 'app.read_state',
            args: {},
          });
        },
      },
    }),
  });
  const context = {
    sessionId: 's1',
    uiMode: 'chat',
    capabilitySnapshot: {
      id: 'shadow-snapshot',
      useCandidates: false,
      promptFeatures: features,
      cohort: {},
    },
  };
  const expected = buildMaidModelPlannerMessages({
    input: '看看状态',
    context: { sessionId: 's1', uiMode: 'chat' },
    features,
  });
  const result = await planner('看看状态', context);
  assert.equal(result.ok, true);
  assert.deepEqual(capturedMessages, expected, 'Shadow snapshot 不得改变发送给模型的 messages');
  assert.equal(context.capabilitySnapshot.cohort.model, 'weak-model');
  console.log('ok - Shadow capability snapshot keeps planner messages byte-equivalent and annotates model cohort');
}

{
  const candidateFeatures = [{
    id: 'app.state.read',
    title: '读取状态',
    aliases: ['看看状态'],
    tools: ['app.read_state'],
    riskLevel: 'low',
    writes: false,
    toolSchemas: {
      'app.read_state': { type: 'object', properties: {} },
    },
  }];
  let systemPrompt = '';
  const planner = createMaidModelBackedPlanner({
    features: [{
      id: 'outside.feature',
      title: '不应出现',
      tools: ['outside.tool'],
    }],
    resolveRuntimeConfig: async () => ({
      config: { provider: 'custom', model: 'weak-model' },
      client: {
        chat: async (messages) => {
          systemPrompt = messages.map(message => message.content).join('\n');
          return JSON.stringify({
            ok: true,
            featureId: 'app.state.reed',
            toolName: 'app.read_state',
            args: {},
          });
        },
      },
    }),
  });
  const result = await planner('看看状态', {
    capabilitySnapshot: {
      id: 'candidate-snapshot',
      useCandidates: true,
      promptFeatures: candidateFeatures,
      cohort: {},
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.featureId, 'app.state.read');
  assert.equal(result.candidateSnapshotId, 'candidate-snapshot');
  assert.equal(result.capabilityCorrection.rule, 'unique_tool_owner');
  assert.match(systemPrompt, /schemas:/);
  // 候选外的功能只以名称进入索引（需先读说明才能用），不带工具与参数
  const detailPart = systemPrompt.slice(systemPrompt.indexOf('<app_features>\n'), systemPrompt.indexOf('</app_features>'));
  assert.doesNotMatch(detailPart, /outside\.feature|outside\.tool/);
  assert.match(systemPrompt, /<app_feature_index>\n- outside\.feature: 不应出现\n<\/app_feature_index>/);
  assert.doesNotMatch(systemPrompt, /outside\.tool/);
  console.log('ok - candidate mode injects only hydrated schemas and corrects IDs inside the snapshot');
}

{
  const context = buildMaidImageGenerationContext({
    config: {
      provider: 'novelai',
      model: 'nai-diffusion-4-full',
      apiKey: 'must-not-leak',
      endpoint: 'https://secret.example.test',
    },
    profile: { id: 'image-profile-1', name: 'NAI 动漫' },
    preset: { id: 'wide', name: '横向壁纸', secretNote: 'must-not-leak' },
    options: {
      width: 1344,
      height: 768,
      promptPrefix: 'best quality, secret-prefix',
      promptSuffix: 'secret-suffix',
      negativePrompt: 'secret-negative',
    },
    negativeCapability: { supported: true },
    referenceCapability: { supported: false, max: 0 },
  });
  assert.equal(context.promptDialect, 'nai_tags');
  assert.equal(context.promptLanguage, 'en');
  assert.equal(context.width, 1344);
  assert.equal(context.height, 768);
  assert.equal(context.promptPrefixApplied, true);
  assert.equal(context.promptSuffixApplied, true);
  assert.equal(context.negativePromptSupported, true);
  const serialized = JSON.stringify(context);
  assert.doesNotMatch(serialized, /must-not-leak|secret-prefix|secret-suffix|secret-negative|secret\.example/);
  console.log('ok - maid image generation context exposes only safe NovelAI prompt metadata');
}

{
  const mediaFeature = [{
    id: 'session.wallpaper',
    title: '设置聊天室壁纸',
    tools: ['media.generate_image', 'session.set_wallpaper'],
  }];
  const unrelatedFeature = [{
    id: 'app.state.read',
    title: '读取状态',
    tools: ['app.read_state'],
  }];
  let contextReads = 0;
  const captured = [];
  const planner = createMaidModelBackedPlanner({
    features: unrelatedFeature,
    getImageGenerationContext: async () => {
      contextReads += 1;
      return {
        provider: 'novelai',
        model: 'nai-diffusion-4-full',
        promptDialect: 'nai_tags',
        promptLanguage: 'en',
        width: 1344,
        height: 768,
        negativePromptSupported: true,
      };
    },
    resolveRuntimeConfig: async () => ({
      client: {
        chat: async messages => {
          captured.push(messages);
          return JSON.stringify({
            ok: true,
            featureId: 'session.wallpaper',
            toolName: 'media.generate_image',
            args: { prompt: '1girl, school uniform' },
          });
        },
      },
    }),
  });
  const result = await planner('帮这个聊天室生成壁纸', {
    capabilitySnapshot: {
      id: 'media-candidates',
      useCandidates: true,
      candidateFeatures: mediaFeature,
      promptFeatures: mediaFeature,
      cohort: {},
    },
  });
  assert.equal(result.ok, true);
  assert.equal(contextReads, 1);
  assert.match(captured[0][1].content, /<image_generation_context>/);
  assert.match(captured[0][1].content, /nai_tags/);
  assert.match(captured[0][1].content, /English comma-separated NovelAI\/Danbooru tags/);
  assert.match(
    captured[0][1].content,
    /exact ASCII subjectAliases item/,
    'NAI prompt contract must tell the model how to pass subject identity without Chinese prose',
  );
  assert.match(
    captured[0][1].content,
    /Do not pass width, height, size, model, provider, profileId, or presetId/,
    'runtime generation metadata must be clearly marked read-only for tool args',
  );

  const unrelatedCaptured = [];
  const unrelatedPlanner = createMaidModelBackedPlanner({
    features: unrelatedFeature,
    getImageGenerationContext: async () => {
      contextReads += 1;
      return { provider: 'novelai', promptDialect: 'nai_tags' };
    },
    resolveRuntimeConfig: async () => ({
      client: {
        chat: async messages => {
          unrelatedCaptured.push(messages);
          return JSON.stringify({
            ok: true,
            featureId: 'app.state.read',
            toolName: 'app.read_state',
            args: {},
          });
        },
      },
    }),
  });
  const unrelated = await unrelatedPlanner('看看状态', {
    capabilitySnapshot: {
      id: 'read-candidates',
      useCandidates: true,
      candidateFeatures: unrelatedFeature,
      promptFeatures: unrelatedFeature,
      cohort: {},
    },
  });
  assert.equal(unrelated.ok, true);
  assert.equal(contextReads, 1, '无生图候选时不应读取图片配置');
  assert.doesNotMatch(unrelatedCaptured[0][1].content, /image_generation_context/);
  console.log('ok - planner injects current image prompt dialect only for image-generation candidates');
}

{
  const mediaFeature = [{
    id: 'session.wallpaper',
    title: '设置聊天室壁纸',
    tools: ['media.generate_image', 'session.set_wallpaper'],
  }];
  let provider = 'novelai';
  const prompts = [];
  const reactPlanner = createMaidModelBackedReActPlanner({
    features: mediaFeature,
    getImageGenerationContext: async () => ({
      provider,
      model: provider === 'novelai' ? 'nai-diffusion-4-full' : 'gpt-image-1',
      promptDialect: provider === 'novelai' ? 'nai_tags' : 'natural_language',
      promptLanguage: provider === 'novelai' ? 'en' : 'auto',
    }),
    resolveRuntimeConfig: async () => ({
      client: {
        chat: async messages => {
          prompts.push(messages[1].content);
          return JSON.stringify({ ok: true, action: 'final', message: '完成' });
        },
      },
    }),
  });
  const baseContext = {
    capabilitySnapshot: {
      id: 'media-react-candidates',
      useCandidates: true,
      candidateFeatures: mediaFeature,
      promptFeatures: mediaFeature,
      cohort: {},
    },
    maidReactSteps: [],
  };
  await reactPlanner('继续生成壁纸', baseContext);
  provider = 'openai';
  await reactPlanner('继续生成壁纸', baseContext);
  assert.match(prompts[0], /"provider":"novelai"/);
  assert.match(prompts[1], /"provider":"openai"/);
  assert.doesNotMatch(prompts[1], /nai-diffusion-4-full/);
  console.log('ok - ReAct refreshes image generation context after profile changes');
}

{
  const runContinuation = {
    version: 'maid-run-continuation-v1',
    sourceRunId: 'run-previous',
    goal: '建立春物角色卡',
    successfulSteps: [{
      toolName: 'persona.create',
      argsDigest: 'fnv1a32:test',
      resourceRefs: [{ kind: 'persona', id: 'persona-oregairu', name: '总武高' }],
      verification: 'readback',
    }],
    remainingTodos: [{ id: 'todo-group', content: '建立侍奉部群聊', status: 'pending' }],
  };
  const plannerText = String(buildMaidModelPlannerMessages({
    input: '继续这条已中断的女仆任务。',
    context: { runContinuation },
    conversationContext: {},
    features: [],
  })[1].content);
  const reactText = String(buildMaidModelReActMessages({
    input: '继续这条已中断的女仆任务。',
    context: { runContinuation },
    conversationContext: {},
    features: [],
    steps: [],
  })[1].content);
  assert.match(plannerText, /<maid_run_continuation/);
  assert.match(plannerText, /persona-oregairu/);
  assert.match(reactText, /todo-group/);
  assert.match(buildMaidModelPlannerMessages({
    input: '继续',
    context: { runContinuation },
    conversationContext: {},
    features: [],
  })[0].content, /稳定 ID.*复验/u);
  console.log('ok - Planner and ReAct receive the structured cross-run ledger');
}

{
  const input = '请按《目标作品》原作建立世界书，不要硬编。';
  const plannerText = String(buildMaidModelPlannerMessages({
    input,
    context: {},
    conversationContext: {},
    features: [],
  })[1].content);
  const reactText = String(buildMaidModelReActMessages({
    input,
    context: {},
    conversationContext: {},
    features: [],
    steps: [{
      toolName: 'web.research',
      status: 'succeeded',
      args: { target: '目标作品' },
      output: {
        targetCheck: { checked: true },
        sources: [{ title: '目标作品官方资料', url: 'https://example.com/canon', targetRelevant: true }],
      },
    }],
  })[1].content);
  assert.match(plannerText, /<maid_source_grounding/);
  assert.match(plannerText, /strict_no_invent/);
  assert.match(reactText, /https:\/\/example\.com\/canon/);
  assert.match(buildMaidModelReActMessages({
    input,
    context: {},
    conversationContext: {},
    features: [],
    steps: [],
  })[0].content, /sourceLayer/);
  console.log('ok - Planner and ReAct receive source-layering rules and verified canon references');
}

{
  // 取消贯通：signal 进入 client.chat；AbortError 不触发 fallback 重试（多计费一次），并向上穿透
  const controller = new AbortController();
  let capturedSignal = null;
  let fallbackCalls = 0;
  const planner = createMaidModelBackedPlanner({
    resolveRuntimeConfig: async () => ({
      configured: true,
      client: {
        chat: async (_messages, options) => {
          capturedSignal = options?.signal || null;
          controller.abort();
          const error = new Error('stopped by user');
          error.name = 'AbortError';
          throw error;
        },
      },
      fallbackClient: {
        chat: async () => {
          fallbackCalls += 1;
          return '{"ok":true}';
        },
      },
    }),
    isConfigReady: () => true,
    logger: { warn() {}, debug() {} },
  });
  await assert.rejects(
    () => planner('打开设置', { signal: controller.signal }),
    error => error?.name === 'AbortError',
  );
  assert.equal(capturedSignal, controller.signal);
  assert.equal(fallbackCalls, 0);
  console.log('ok - planner cancellation never retries the fallback model and rethrows AbortError');
}

{
  // 供应商内部超时也可能抛 AbortError；外层 signal 未中止时不得冒充用户取消。
  const controller = new AbortController();
  let fallbackCalls = 0;
  const planner = createMaidModelBackedPlanner({
    resolveRuntimeConfig: async () => ({
      configured: true,
      client: {
        chat: async () => {
          const error = new Error('provider timeout aborted');
          error.name = 'AbortError';
          throw error;
        },
      },
      fallbackClient: {
        chat: async () => {
          fallbackCalls += 1;
          return JSON.stringify({
            ok: false,
            status: 'unsupported',
            reason: 'fallback_used',
            message: '已切换备用模型。',
          });
        },
      },
    }),
    isConfigReady: () => true,
    logger: { warn() {}, debug() {} },
  });
  const result = await planner('打开设置', { signal: controller.signal });
  assert.equal(controller.signal.aborted, false);
  assert.equal(fallbackCalls, 1);
  assert.equal(result.reason, 'fallback_used');
  console.log('ok - provider AbortError with a live caller signal remains a failure and may use fallback');
}

{
  // 临时故障先对同一模型重试（最多 2 次），仍失败才转备用档或报错；参数类错误不重试
  const { configureMaidModelRetry, isMaidTransientModelError, createMaidModelBackedPlanner: createPlanner } = await import('../../src/scripts/agent/maid-model-planner.js');
  const previous = configureMaidModelRetry();
  configureMaidModelRetry({ delaysMs: [0, 0] });
  const okPlan = JSON.stringify({ ok: true, toolName: 'regex.list', args: {}, featureId: 'regex.list', title: '查看正则', response: '好的' });
  const makePlanner = (client, fallbackClient = null) => createPlanner({
    resolveRuntimeConfig: async () => ({ configured: true, config: { provider: 'custom', model: 'm' }, client, fallbackClient }),
    logger: { warn() {}, debug() {} },
  });
  for (const message of ['Vertex AI Error: 429 - Resource exhausted.', 'Empty response from Vertex AI', 'Failed to authenticate with Service Account: undefined', 'HTTP 503 Service Unavailable']) {
    assert.equal(isMaidTransientModelError(new Error(message)), true, message);
  }
  for (const message of ['Vertex AI Error: 400 - Request contains an invalid argument.', 'HTTP 401 Unauthorized']) {
    assert.equal(isMaidTransientModelError(new Error(message)), false, message);
  }

  let calls = 0;
  const flaky = { chat: async () => { calls += 1; if (calls < 3) throw new Error('Vertex AI Error: 429 - Resource exhausted.'); return okPlan; } };
  const recovered = await makePlanner(flaky)('看看正则', {});
  assert.equal(recovered.ok, true);
  assert.equal(calls, 3, 'two retries on the same model');

  let primaryCalls = 0;
  let fallbackCalls = 0;
  const rejected = { chat: async () => { primaryCalls += 1; throw new Error('Vertex AI Error: 400 - Request contains an invalid argument.'); } };
  const fallback = { chat: async () => { fallbackCalls += 1; return okPlan; } };
  const viaFallback = await makePlanner(rejected, fallback)('看看正则', {});
  assert.equal(viaFallback.ok, true);
  assert.equal(primaryCalls, 1, 'a rejected request is not retried');
  assert.equal(fallbackCalls, 1);

  let stubbornCalls = 0;
  const stubborn = { chat: async () => { stubbornCalls += 1; throw new Error('Vertex AI Error: 429 - Resource exhausted.'); } };
  const failed = await makePlanner(stubborn)('看看正则', {});
  assert.equal(failed.ok, false, 'without a fallback profile the error is reported');
  assert.equal(stubbornCalls, 3);

  let emptyCalls = 0, emptyFallbackCalls = 0;
  const emptyFallback = { chat: async () => { emptyFallbackCalls++; return okPlan; } };
  const emptyThenReady = await makePlanner({ chat: async () => ++emptyCalls === 1 ? '  \n' : okPlan }, emptyFallback)('看看正则', {});
  assert.equal(emptyThenReady.ok, true);
  assert.equal(emptyCalls, 2);
  assert.equal(emptyFallbackCalls, 0, 'blank text retries the same client before fallback');
  emptyCalls = 0;
  const emptyThenFallback = await makePlanner({ chat: async () => { emptyCalls++; return ''; } }, emptyFallback)('看看正则', {});
  assert.equal(emptyThenFallback.ok, true);
  assert.equal(emptyCalls, 3);
  assert.equal(emptyFallbackCalls, 1, 'persistent empty text uses fallback after two retries');
  const allEmpty = await makePlanner({ chat: async () => '' }, { chat: async () => '' })('看看正则', {});
  assert.equal(allEmpty.ok, false);
  assert.notEqual(allEmpty.reason, 'invalid_model_plan', 'empty provider output is a request failure, not a malformed plan');

  const usage = [];
  const metered = createPlanner({
    getProviderFcExperimentStatus: () => ({ enabled: false }),
    resolveRuntimeConfig: async () => ({ configured: true,
      config: { provider: 'custom', model: 'primary' }, fallbackConfig: { provider: 'custom', model: 'fallback' },
      client: { chat: async (_messages, options) => {
        options.onProviderUsage({ promptTokens: 50, completionTokens: 5, totalTokens: 55 });
        options.onProviderUsage({ promptTokens: 100, completionTokens: 10, totalTokens: 110 });
        return '';
      } },
      fallbackClient: { chat: async (_messages, options) => {
        options.onProviderUsage({ promptTokens: 200, completionTokens: 20, totalTokens: 220 });
        return okPlan;
      } },
    }), logger: { warn() {}, debug() {} },
  });
  assert.equal((await metered('看看正则', { onModelUsage: entry => usage.push(entry) })).ok, true);
  assert.equal(usage.length, 4);
  assert.equal(usage.reduce((sum, entry) => sum + entry.totalTokens, 0), 550, 'every charged attempt counts, cumulative callbacks count once');
  assert.equal(usage.reduce((sum, entry) => sum + entry.modelCallCount, 0), 4);
  assert.deepEqual(usage.map(entry => entry.model), ['primary', 'primary', 'primary', 'fallback']);
  assert.deepEqual(usage.map(entry => entry.degraded), [false, false, false, true]);

  configureMaidModelRetry({ delaysMs: [60000] });
  const controller = new AbortController();
  const waiting = makePlanner(stubborn)('看看正则', { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  const started = Date.now();
  await waiting.catch(() => null);
  assert.ok(Date.now() - started < 5000, 'cancelling stops the backoff wait');
  configureMaidModelRetry({ delaysMs: previous });
  console.log('ok - transient model failures retry on the same model before falling back or failing');
}

{
  // 女仆思考设置：按实际调用的模型换成对应参数；降级档用自己的映射，不会收到主档的参数；模型默认不改动请求
  const { createMaidModelBackedPlanner: createPlanner } = await import('../../src/scripts/agent/maid-model-planner.js');
  const okPlan = JSON.stringify({ ok: true, toolName: 'regex.list', args: {}, featureId: 'regex.list', title: '查看正则', response: '好的' });
  const seen = [];
  const run = async (generationSettings, { failPrimary = false } = {}) => {
    seen.length = 0;
    const planner = createPlanner({
      resolveRuntimeConfig: async () => ({
        configured: true,
        config: { provider: 'vertexai', model: 'gemini-3.8-flash' },
        client: { chat: async (_messages, options) => { seen.push(['primary', options]); if (failPrimary) throw new Error('HTTP 400 bad'); return okPlan; } },
        fallbackConfig: { provider: 'deepseek', model: 'deepseek-flash' },
        fallbackClient: { chat: async (_messages, options) => { seen.push(['fallback', options]); return okPlan; } },
        generationSettings,
      }),
      logger: { warn() {}, debug() {} },
    });
    assert.equal((await planner('看看正则', {})).ok, true);
    return seen.map(([who, options]) => [who, options]);
  };
  const [[, offPrimary]] = await run({ reasoningMode: 'off', reasoningEffort: 'low' });
  assert.equal(offPrimary.thinkingLevel, undefined, 'models that cannot turn thinking off get no extra request');
  assert.equal(offPrimary.maxTokens, 8000);
  const [[, onPrimary]] = await run({ reasoningMode: 'on', reasoningEffort: 'low' });
  assert.equal(onPrimary.thinkingLevel, 'low');
  assert.equal(onPrimary.maxTokens, 8000, 'the call keeps its own output budget');
  assert.equal(onPrimary.max_tokens, 8000);
  const calls = await run({ reasoningMode: 'off', reasoningEffort: 'low' }, { failPrimary: true });
  const fallbackOptions = calls.find(([who]) => who === 'fallback')[1];
  assert.deepEqual(fallbackOptions.thinking, { type: 'disabled' }, 'DeepSeek fallback turns thinking off with its own parameter');
  assert.equal(fallbackOptions.thinkingLevel, undefined);
  const [[, untouched]] = await run({ reasoningMode: 'default' });
  assert.equal(untouched.thinking, undefined);
  assert.equal(untouched.thinkingLevel, undefined);
  console.log('ok - maid reasoning settings map per model, including the fallback profile');
}

{
  // 文本 JSON 路径的最终答复与函数调用路径同一上限（6000），长清单不在 1200 处截断
  const { createMaidModelBackedReActPlanner: createMaidModelReActPlanner } = await import('../../src/scripts/agent/maid-model-planner.js');
  const longMessage = `${'规则集名称，'.repeat(400)}FINAL_ENTRY`;
  for (const reply of [JSON.stringify({ ok: true, action: 'final', message: longMessage }), longMessage]) {
    const reactPlanner = createMaidModelReActPlanner({
      resolveRuntimeConfig: async () => ({ configured: true, config: { provider: 'custom', model: 'm' }, client: { chat: async () => reply } }),
      logger: { warn() {}, debug() {} },
    });
    const decision = await reactPlanner('列出所有规则集', { maidReactSteps: [{ index: 1, toolName: 'regex.list', status: 'succeeded', output: {} }] });
    assert.equal(decision.ok, true);
    assert.match(decision.message, /FINAL_ENTRY$/, 'the end of a long list survives the text path');
  }
  console.log('ok - long final answers on the text JSON path are not cut at 1200 characters');
}
