import assert from 'node:assert/strict';
import {
  buildMemoryPlanAudit,
  buildRequestInjectionAudit,
  estimatePromptMessagesTokens,
  estimatePromptToolsTokens,
  formatInjectionAuditText,
  promptMessagesContainNonTextContent,
} from '../../src/scripts/memory/memory-injection-audit-utils.js';
import { estimateTokens } from '../../src/scripts/memory/memory-prompt-utils.js';
import {
  renderMemoryInjectionAuditHtml,
} from '../../src/scripts/ui/chat/memory-injection-audit-view-utils.js';

const memoryAudit = buildMemoryPlanAudit({
  localTableText: '【任务】\n- 继续调查',
  localRowCount: 1,
  localTrimmedCount: 2,
  crossScopeSegments: [{
    id: 'memory_group_private',
    label: '群聊成员私聊',
    text: '【成员：甲】\n- 已建立信任',
    rowCount: 1,
  }],
  dataPromptText: '<memories>\n【任务】\n- 继续调查\n【成员：甲】\n- 已建立信任\n</memories>',
  guidePromptText: '<memory_edit_rules>只输出 tableEdit</memory_edit_rules>',
});

assert.equal(memoryAudit.version, 1);
assert.ok(memoryAudit.segments.some(item => item.id === 'memory_local' && item.rowCount === 1));
assert.ok(memoryAudit.segments.some(item => item.id === 'memory_group_private' && item.rowCount === 1));
assert.ok(memoryAudit.segments.some(item => item.id === 'memory_guide'));
assert.ok(memoryAudit.usedTokens > 0);
assert.ok(buildMemoryPlanAudit({ guidePromptText: '纯中文指引' }).usedTokens > 0);

const requestAudit = buildRequestInjectionAudit({
  memoryPlan: { audit: memoryAudit },
  history: [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好，有什么事？' },
  ],
  worldDebug: {
    budgetTokens: 100,
    usedTokens: 20,
    mergedEntries: [{ entryId: 'a' }],
    trimmedEntries: [{ entryId: 'b' }],
    overflowed: true,
  },
  messages: [
    { role: 'system', content: '系统提示词' },
    { role: 'system', content: '<memories>记忆</memories>' },
    { role: 'user', content: [{ type: 'text', text: '你好' }, { type: 'image_url', image_url: { url: 'x' } }] },
  ],
  budget: {
    inputBudgetTokens: 1000,
    outputReserveTokens: 200,
    safetyReserveTokens: 64,
    fixedReserveTokens: 120,
    allocations: { recent: 400 },
  },
});
requestAudit.coverageLine = {
  coverageRate: 0.75,
  holes: [{ from: 4, to: 5 }],
  protectedMessageCount: 2,
};

assert.equal(requestAudit.inputBudgetTokens, 1000);
assert.ok(requestAudit.segments.some(item => (
  item.id === 'history' && item.messageCount === 2 && item.quotaTokens === 400
)));
assert.ok(requestAudit.segments.some(item => item.id === 'world' && item.trimmedCount === 1));
assert.ok(requestAudit.totalEstimateTokens > 0);
assert.match(formatInjectionAuditText(requestAudit), /本次注入构成|注入总量/);
assert.match(formatInjectionAuditText(requestAudit), /空洞 4-5/);

const html = renderMemoryInjectionAuditHtml(requestAudit);
assert.match(html, /本次注入构成/);
assert.match(html, /群聊成员私聊/);
assert.match(html, /已强制保留 2 条原文消息/);
assert.doesNotMatch(html, /<script>/);

console.log('ok - memory injection audit aggregates memory history world and fixed prompt segments');

{
  const audit = buildRequestInjectionAudit({
    history: [],
    messages: [
      { role: 'system', content: 'global semantic block' },
      { role: 'user', content: 'hello' },
    ],
    extraSegments: [{
      id: 'global_prompt_library',
      label: '全局提示词',
      text: 'global semantic block',
      messageCount: 1,
    }],
  });
  const global = audit.segments.find(item => item.id === 'global_prompt_library');
  assert.equal(global?.label, '全局提示词');
  assert.equal(global?.messageCount, 1);
  assert.ok(global?.usedTokens > 0);
  assert.ok(audit.segments.some(item => item.id === 'fixed'));
  console.log('ok - request injection audit attributes global semantic prompts independently');
}

// 护栏 3 的具体报警：state 超配额 = 该表没做覆盖式更新，必须在审计里点名
const overQuotaAudit = buildRequestInjectionAudit({
  memoryPlan: null,
  history: [{ role: 'user', content: '正文' }],
  messages: [{ role: 'user', content: '正文' }],
  budget: {
    inputBudgetTokens: 1000,
    allocations: { recent: 400 },
    overQuotaSegments: ['state'],
  },
});
assert.deepEqual(overQuotaAudit.overQuotaSegments, ['state']);
assert.match(formatInjectionAuditText(overQuotaAudit), /常驻状态超出配额.*覆盖式/);
assert.match(renderMemoryInjectionAuditHtml(overQuotaAudit), /常驻状态超出配额/);

const noOverQuotaAudit = buildRequestInjectionAudit({
  history: [],
  messages: [{ role: 'user', content: '正文' }],
  budget: { inputBudgetTokens: 1000 },
});
assert.deepEqual(noOverQuotaAudit.overQuotaSegments, []);
assert.doesNotMatch(formatInjectionAuditText(noOverQuotaAudit), /超出配额/);

console.log('ok - state over-quota guardrail warning is surfaced in audit text and html');

{
  // 写表指引段与其他段共用同一 tokenMode（含校准系数），不再少乘系数导致
  // guide 段偏小、fixed 段（总量-已知段）被同量高估。
  const guideText = '<memory_edit_rules>只输出 tableEdit</memory_edit_rules>';
  const findGuide = audit => audit.segments.find(item => item.id === 'memory_guide');
  const baseGuide = findGuide(buildMemoryPlanAudit({ guidePromptText: guideText }));
  const calibratedGuide = findGuide(buildMemoryPlanAudit({
    guidePromptText: guideText,
    tokenMode: { mode: 'rough', coefficient: 2 },
  }));
  assert.equal(calibratedGuide.usedTokens, estimateTokens(guideText, { mode: 'rough', coefficient: 2 }));
  assert.ok(calibratedGuide.usedTokens > baseGuide.usedTokens);
  console.log('ok - guide segment applies the calibrated token mode like every other segment');
}

{
  // 非文本 part 检测：校准取样前排除带图/语音请求
  assert.equal(promptMessagesContainNonTextContent([{ role: 'user', content: '纯文本' }]), false);
  assert.equal(promptMessagesContainNonTextContent([
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
  ]), false);
  assert.equal(promptMessagesContainNonTextContent([
    { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }] },
  ]), true);
  assert.equal(promptMessagesContainNonTextContent([
    { role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'x' } }] },
  ]), true);
  console.log('ok - non-text prompt content is detected for calibration exclusion');
}

{
  // 工具定义与历史里的工具调用也算输入（供应方 usage 含这两部分），只算正文会少估、把校准系数顶高
  const call = { id: 'c1', type: 'function', function: { name: 'soliumbra_reply', arguments: '{"game_content":"测试连通性，一切正常"}' } };
  const plain = [{ role: 'user', content: '继续' }, { role: 'assistant', content: null }];
  const withCall = [{ role: 'user', content: '继续' }, { role: 'assistant', content: null, tool_calls: [call] }];
  assert.ok(estimatePromptMessagesTokens(withCall) > estimatePromptMessagesTokens(plain), 'tool call arguments are counted');
  const tools = [{ type: 'function', function: { name: 'context', description: '世界设定与人设原文'.repeat(40), parameters: { type: 'object', properties: {} } } }];
  const toolTokens = estimatePromptToolsTokens(tools, { mode: 'rough', coefficient: 1.5 });
  assert.equal(toolTokens, estimateTokens(JSON.stringify(tools), { mode: 'rough', coefficient: 1.5 }));
  assert.equal(estimatePromptToolsTokens([]), 0);
  assert.equal(estimatePromptToolsTokens(undefined), 0);
  const tokenMode = { mode: 'rough', coefficient: 1.5 };
  const audit = buildRequestInjectionAudit({ messages: withCall, tools, tokenMode, budget: { inputBudgetTokens: 100000 } });
  assert.equal(audit.totalEstimateTokens, estimatePromptMessagesTokens(withCall, tokenMode) + toolTokens, 'total includes tool definitions');
  assert.equal(audit.segments.find(item => item.id === 'fixed')?.usedTokens, audit.totalEstimateTokens, 'tool tokens fall into the existing other-prompts segment, no separate segment');
  console.log('ok - request estimate counts tool definitions and tool call arguments');
}
