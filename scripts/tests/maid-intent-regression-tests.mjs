import assert from 'node:assert/strict';

import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { listAppFeatures, searchAppFeatures } from '../../src/scripts/agent/app-feature-catalog.js';
import { createMaidCapabilityRoutingRuntime } from '../../src/scripts/agent/maid-capability-routing.js';

// 女仆意图回归基线（golden fixtures）。
// 目的：固定“用户说法 -> 命中能力/工具”的行为，防止检索评分改动造成回归。
// 修改功能目录或评分规则后如果这里失败，先确认新行为是否更好，再更新基线。

// 一、功能检索基线：searchAppFeatures 的 top-1 命中。
// 检索结果同时决定模型 planner 提示词中的候选功能，top-1 错误会直接误导模型。
const RETRIEVAL_FIXTURES = [
  // 16.4 验收样例
  { input: '世界书重复了帮我清理', expect: 'worldbook.delete_entries' },
  { input: '给这个角色换头像', expect: 'persona.avatar.set' },
  { input: '读取当前预设', expect: 'app.resource.read' },
  // 导航与打开
  { input: '打开会话配置', expect: 'session.config.open' },
  { input: '我想设置API', expect: 'config.api.open' },
  { input: '打开世界书', expect: 'worldbook.open' },
  { input: '打开记忆表格', expect: 'memory.open' },
  { input: '你记得什么', expect: 'maid.memory.list' },
  { input: '归档女仆记忆', expect: 'maid.memory.archive' },
  { input: '打开变量面板', expect: 'variables.open' },
  { input: '打开正则', expect: 'regex.open' },
  // 会话与消息
  { input: '创建一个叫小美的聊天室', expect: 'session.create' },
  { input: '清理测试用的房间', expect: 'session.delete_many' },
  { input: '哪些房是测试用的', expect: 'session.list' },
  { input: '给小美发消息晚上好', expect: 'chat.send_message' },
  { input: '批量删除测试角色卡', expect: 'persona.delete_many' },
  // 世界书
  { input: '删除世界书重复条目', expect: 'worldbook.delete_entries' },
  { input: '删除这些测试世界书', expect: 'worldbook.delete_many' },
  { input: '把世界书绑定到聊天室', expect: 'worldbook.bind_session' },
  { input: '看看世界书里有什么', expect: 'worldbook.open' },
  // 观察与联网
  { input: '看看当前用了哪些资源', expect: 'app.state.read' },
  { input: '看一下当前界面', expect: 'app.visible_panel.read' },
  { input: '帮我搜一下今天的新闻', expect: 'web.search' },
  // 图片资产
  { input: '把这张图设为壁纸', expect: 'session.wallpaper.set' },
  { input: '生成一张月夜森林图设为聊天室壁纸', expect: 'session.wallpaper.set' },
  { input: '用这张图生成一张相似构图', expect: 'chat.image.generate' },
  { input: '看看我圈选的这里为什么错位', expect: 'app.ui.capture_region' },
  { input: '看看我圈选的图片是什么', expect: 'app.ui.capture_region' },
  { input: '这里配色好看吗', expect: 'app.ui.capture_region' },
  { input: '比较这两个圈选区域的布局', expect: 'app.ui.capture_region' },
  { input: '这个区域的文字为什么被遮住', expect: 'app.ui.capture_region' },
  // 能力自描述
  { input: '你能做什么', expect: 'app.capabilities.search' },
  { input: '女仆有什么功能', expect: 'app.capabilities.search' },
  // 错误自查
  { input: '刚才为什么失败', expect: 'app.errors.read' },
  { input: '看看最近错误', expect: 'app.errors.read' },
  // 格式修复
  { input: '这次回复掉格式了', expect: 'chat.format.repair' },
  { input: '帮我修一下格式', expect: 'chat.format.repair' },
  { input: '回复格式不对', expect: 'chat.format.repair' },
  // 正文优化
  { input: '帮我润色一下这条回复', expect: 'chat.message.optimize' },
  { input: '这段写得太啰嗦了帮我精简', expect: 'chat.message.optimize' },
  { input: '删掉重复的句子', expect: 'chat.message.optimize' },
  // 格式画像
  { input: '记住这个格式', expect: 'chat.format.profile' },
  { input: '这个卡是什么格式', expect: 'chat.format.profile' },
];

// 2026-07-28 冻结观察的 planner 长尾 miss：不要求 catalog 词法 top-1，
// 但 Shadow Top-K 必须覆盖真实选择所需能力。覆盖中英混写、口语、错字和复合 UI 流程。
const SHADOW_LONG_TAIL_FIXTURES = [
  { input: '列出聊天范围的所有连线档，并指出当前启用档；绝对不要执行切换。', expect: ['config.model.switch'] },
  { input: '读取最近五条女仆或工具失败记录，按 failureCode 归类；没有就说没有。', expect: ['app.errors.read'] },
  { input: '联网查一下今天台北的天气概况，给出来源名称；不要修改 APP 数据。', expect: ['web.search'] },
  { input: '网上找两张橘猫照片并给出图片网址，不要下载、不要设头像或壁纸。', expect: ['web.search'] },
  { input: '把目前最后一轮 AI 回复的 rawOriginal 读出来，回答它是否与显示文本一致。', expect: ['app.resource.read'] },
  { input: '先看清当前可见界面，再告诉我有没有打开中的弹窗或侧栏。', expect: ['app.visible_panel.read'] },
  { input: '房间清单给我瞅一眼，数数一共有几间；别进去任何一间。', expect: ['session.list'] },
  { input: 'list my chats，并告诉我有没有名称带“测试”的会话。', expect: ['session.list'] },
  { input: '清理所有名称带“批量冒烟”的测试房，但当前房间不要动。', expect: ['session.delete_many'] },
  { input: 'where am I in the app？请用工具查，不要凭上下文猜。', expect: ['app.state.read'] },
  { input: '这屋现在挂着啥 vars？读数据就好，别弹变量编辑器。', expect: ['app.resource.read'] },
  { input: '当前绑了哪些后处理规则？只念名单，莫打开 regexp 页面。', expect: ['app.resource.read'] },
  { input: '咱现在套的是哪份 preset 啊？查名字，别换。', expect: ['app.resource.read'] },
  { input: '目前走哪家 provider、哪个 model？列线配置查一下就行。', expect: ['config.model.switch'] },
  { input: '角色皮有几张？当前是哪张？只读 character cards。', expect: ['app.resource.read'] },
  { input: '批量删除名称带“批量冒烟”的测试角色卡，至少保留当前角色。', expect: ['persona.delete_many'] },
  { input: '不跳房间，偷看一下「测试花园」末条消息是谁发的、几点发的。', expect: ['app.resource.read'] },
  { input: '世借书都有哪些？我可能打错字了，想看的是 worldbook 名单。', expect: ['worldbook.list'] },
  { input: '删除这些测试世界书，绑定中的也列出来让我一次确认。', expect: ['worldbook.delete_many'] },
  { input: '看看你自己的长期记忆里记了什么，只列生效中的。', expect: ['maid.memory.list'] },
  { input: '把你记住的测试探针找出来并归档，先列清单让我确认。', expect: ['maid.memory.archive', 'maid.memory.list'] },
  { input: '翻一下「花园设定」的目录页，条目标题就够，正文先别端上来。', expect: ['worldbook.read'] },
  { input: '刚才若有翻车，错误簿里最新三笔是什么？', expect: ['app.errors.read'] },
  { input: 'scan 一下当前 UI，告诉我现在露出来哪些 panel。', expect: ['app.visible_panel.read'] },
  { input: '把各模型档的公开字段整理一下，任何 key/token 都不能出现在回答里。', expect: ['config.model.switch'] },
  { input: '正规表达式清单里有没有停用项？从资源读取结果统计。', expect: ['app.resource.read'] },
  { input: '全局变量与局部变量分别列五个名字；没有局部变量就直说空。', expect: ['app.resource.read'] },
  { input: '用状态接口确认现在是否真的位于「冻结观察会话-A-0728」。', expect: ['app.state.read'] },
  {
    input: '把「冻结观察写入-0728」的「门牌规则」正文更新为新内容，只改这一条。',
    context: { maidConversationContext: { historyText: '上一轮正在处理世界书「冻结观察写入-0728」的条目。' } },
    expect: ['worldbook.update_entries', 'worldbook.read'],
  },
  {
    input: '删除「冻结观察写入-0728」里的「观察标记」。',
    context: { maidConversationContext: { historyText: '上一轮正在处理世界书「冻结观察写入-0728」的条目。' } },
    expect: ['worldbook.delete_entries', 'worldbook.read'],
  },
  { input: '优化「格式修复测试」会话最近一条 AI 回复，让措辞更简洁。', expect: ['chat.message.optimize'] },
  { input: '列出所有以「冻结观察会话-」开头的会话，确认 A、B、C 各只有一个。', expect: ['session.list'] },
  { input: '若会话 D 不存在就创建；然后写入消息；最后读取末条消息验证。', expect: ['maid.todo', 'session.create', 'chat.send_message', 'app.resource.read'] },
  {
    input: '打开 Agent Center，先读取界面 ref，再点击“活动”标签并读取点击后的摘要；禁止用坐标盲点。',
    expect: ['agent.center.open', 'app.visible_panel.read', 'app.ui.click'],
  },
  { input: 'show me every conversation name, read only.', expect: ['session.list'] },
  { input: '眼前露着啥窗口？scan visible UI only。', expect: ['app.visible_panel.read'] },
  { input: 'character cards inventory：总数＋active name，只读。', expect: ['app.resource.read'] },
  { input: 'user identities 列表与当前身份，只查别换。', expect: ['app.resource.read'] },
  { input: 'chat model profiles 名单和 active 档，read only。', expect: ['config.model.switch'] },
  { input: '查一下今天 WebView2 官方文档有没有提 remote debugging port，并给来源。', expect: ['web.search'] },
  { input: 'image search only：three foggy lighthouse references，别下载。', expect: ['web.search'] },
  { input: 'show the variables panel，停在那里不要改。', expect: ['variables.open'] },
  {
    input: '模型连线设置在哪？直接替我打开配置页，但别保存。',
    context: {
      maidConversationContext: {
        historyText: '世界书的 AI 生成模板现在是自定义还是默认？读取设置，不生成内容。只查询当前会话有哪些记忆模板，不要开启记忆面板。正规表达式清单里有没有停用项？全局变量与局部变量分别列五个名字。',
      },
    },
    expect: ['config.api.open'],
  },
  {
    input: '把这间聊天的配置摘要窗口打开，我要自己检查。',
    context: {
      maidConversationContext: {
        historyText: '世界书的 AI 生成模板现在是自定义还是默认？读取设置，不生成内容。只查询当前会话有哪些记忆模板，不要开启记忆面板。正规表达式清单里有没有停用项？全局变量与局部变量分别列五个名字。',
      },
    },
    expect: ['session.config.open'],
  },
  { input: '这房间的 custom output schema 缓存过没？read format profile。', expect: ['chat.format.profile'] },
  { input: 'world lore library 有几本？只列书名。', expect: ['worldbook.list'] },
  { input: 'latest maid failures 给我五条 failureCode。', expect: ['app.errors.read'] },
];

for (const { input, expect } of RETRIEVAL_FIXTURES) {
  const top = searchAppFeatures(input, { limit: 1 })[0];
  assert.ok(top, `「${input}」没有命中任何功能，期望 ${expect}`);
  assert.equal(
    top.id,
    expect,
    `「${input}」top-1 命中 ${top.id}(${top.score})，期望 ${expect}`,
  );
}
console.log(`ok - 功能检索基线 ${RETRIEVAL_FIXTURES.length} 条 top-1 命中`);

{
  const features = listAppFeatures();
  const registry = createAgentToolRegistry({
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { warn() {} },
  });
  const toolNames = new Set(features.flatMap(feature => feature.tools || []));
  toolNames.forEach((name) => {
    registry.register({
      name,
      schema: { type: 'object' },
      execute: async () => ({ ok: true }),
    });
  });
  const routing = createMaidCapabilityRoutingRuntime({
    features,
    toolRegistry: registry,
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { debug() {} },
  });
  for (const { input, expect } of RETRIEVAL_FIXTURES) {
    const request = routing.beginRequest({ input });
    const snapshot = routing.prepareDecision({ requestId: request.id, input, phase: 'planner' });
    assert.ok(
      snapshot.candidateIds.has(expect),
      `「${input}」的 Shadow Top-K 未包含 ${expect}，实际 ${Array.from(snapshot.candidateIds).join(', ')}`,
    );
    assert.ok(snapshot.candidateFeatures.length <= 8, '常规 Shadow 候选不得超过 8 项');
    routing.finishRequest(request.id, { ok: true });
  }
  for (const { input, expect, context = {} } of SHADOW_LONG_TAIL_FIXTURES) {
    const request = routing.beginRequest({ input });
    const snapshot = routing.prepareDecision({ requestId: request.id, input, context, phase: 'planner' });
    for (const expected of expect) {
      assert.ok(
        snapshot.candidateIds.has(expected),
        `长尾「${input}」的 Shadow Top-K 缺少 ${expected}，实际 ${Array.from(snapshot.candidateIds).join(', ')}`,
      );
    }
    assert.ok(snapshot.candidateFeatures.length <= 8, '长尾 Shadow 候选不得超过 8 项');
    routing.finishRequest(request.id, { ok: true });
  }
  const multiIntentInput = '打开世界书、看看当前界面，然后帮我搜一下今天的新闻';
  const multiIntentRequest = routing.beginRequest({ input: multiIntentInput });
  const multiIntentSnapshot = routing.prepareDecision({
    requestId: multiIntentRequest.id,
    input: multiIntentInput,
    phase: 'planner',
  });
  for (const expected of ['worldbook.open', 'app.visible_panel.read', 'web.search']) {
    assert.ok(
      multiIntentSnapshot.candidateIds.has(expected),
      `复合任务候选缺少 ${expected}，实际 ${Array.from(multiIntentSnapshot.candidateIds).join(', ')}`,
    );
  }
  routing.finishRequest(multiIntentRequest.id, { ok: true });
  console.log(`ok - Shadow Retriever ${RETRIEVAL_FIXTURES.length} 条 golden + ${SHADOW_LONG_TAIL_FIXTURES.length} 条真实长尾 fixtures 全部进入 Top-K`);
}

console.log('maid-intent-regression-tests passed');
