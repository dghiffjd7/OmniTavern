import assert from 'node:assert/strict';

import { createChatFormatRepairTools } from '../../src/scripts/agent/tools/chat-format-tools.js';
import { buildChatFormatGuardianModelPrompt } from '../../src/scripts/ui/chat/chat-format-guardian-utils.js';

const getTool = (tools, name) => tools.find(tool => tool.name === name);

{
  const calls = [];
  const tools = createChatFormatRepairTools({
    repairMessageFormat: async (args) => {
      calls.push(args);
      return { ok: true, applied: true, added: 2, removed: 1, summary: '补齐缺失标签' };
    },
  });
  const tool = getTool(tools, 'chat.repair_message_format');
  const result = await tool.execute({
    messageId: 'msg-1',
    sessionName: '小美',
    formatHint: '正文必须包含 <status>...</status> 状态块',
  });
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  assert.deepEqual(calls[0], {
    messageId: 'msg-1',
    sessionId: '',
    sessionName: '小美',
    formatHint: '正文必须包含 <status>...</status> 状态块',
    source: 'maid',
  });
  assert.equal(tool.summarizeResult(result), 'format repair applied (+2/-1)');
  console.log('ok - 修复工具透传参数并汇总应用结果');
}

{
  const tools = createChatFormatRepairTools({});
  const result = await getTool(tools, 'chat.repair_message_format').execute({});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'format_repair_unavailable');
  console.log('ok - 无执行器时返回可读错误');
}

{
  const tools = createChatFormatRepairTools({
    repairMessageFormat: async () => ({
      ok: true,
      applied: false,
      userDecision: 'cancelled',
      message: '用户在 diff 预览中取消了修复。',
    }),
  });
  const tool = getTool(tools, 'chat.repair_message_format');
  const result = await tool.execute({});
  assert.equal(result.ok, true, '用户取消不是失败，避免 ReAct 重试重复弹窗');
  assert.equal(result.applied, false);
  assert.equal(tool.summarizeResult(result), 'format repair cancelled by user in diff preview');
  console.log('ok - 用户取消返回 ok:true + applied:false');
}

{
  const prompt = buildChatFormatGuardianModelPrompt({
    assistantText: '小美--晚上好--21:30',
    customFormatGuide: '每条回复末尾必须有 <status>好感度:N</status> 状态块',
    enabledFormats: { privateChat: true },
  });
  const userMessage = prompt.messages.find(item => item.role === 'user')?.content || '';
  assert.match(userMessage, /# Custom Format Guide/);
  assert.match(userMessage, /<status>好感度:N<\/status>/);
  const withoutGuide = buildChatFormatGuardianModelPrompt({
    assistantText: '小美--晚上好--21:30',
    enabledFormats: { privateChat: true },
  });
  const plainUser = withoutGuide.messages.find(item => item.role === 'user')?.content || '';
  assert.doesNotMatch(plainUser, /# Custom Format Guide/);
  console.log('ok - customFormatGuide 拼入修复 prompt 且缺省不出现');
}

{
  const { runChatFormatGuardianBackgroundChat } = await import('../../src/scripts/ui/chat/after-receive-dispatch-utils.js');
  const calls = [];
  const backgroundChat = async (messages, options = {}) => {
    calls.push({ ...options });
    if (Object.prototype.hasOwnProperty.call(options, 'temperature')) {
      throw new Error('temperature 参数不被该模型支持');
    }
    return '{"status":"ok"}';
  };
  const raw = await runChatFormatGuardianBackgroundChat(backgroundChat, [], { temperature: 0, maxTokens: 900 }, { timeoutMs: 0 });
  assert.equal(raw, '{"status":"ok"}');
  assert.equal(calls.length, 2, '应剥掉 temperature 重试一次');
  assert.equal(Object.prototype.hasOwnProperty.call(calls[1], 'temperature'), false);
  assert.equal(calls[1].maxTokens, 900, '其余参数应保留');

  let otherError = null;
  try {
    await runChatFormatGuardianBackgroundChat(async () => {
      throw new Error('rate limited');
    }, [], { temperature: 0 }, { timeoutMs: 0 });
  } catch (err) {
    otherError = err;
  }
  assert.match(String(otherError?.message), /rate limited/, '非 temperature 错误不应吞掉');
  console.log('ok - temperature 不兼容时剥参重试一次，其他错误原样抛出');
}

{
  const calls = [];
  const tools = createChatFormatRepairTools({
    optimizeMessage: async (args) => {
      calls.push(args);
      return { ok: true, applied: true, added: 3, removed: 5, summary: '精简重复描写' };
    },
  });
  const tool = tools.find(t => t.name === 'chat.optimize_message');
  const result = await tool.execute({ instruction: '更简洁', sessionName: '小美' });
  assert.equal(result.applied, true);
  assert.equal(calls[0].instruction, '更简洁');
  assert.equal(calls[0].sessionName, '小美');
  assert.equal(tool.summarizeResult(result), 'body optimize applied (+3/-5)');

  const bare = createChatFormatRepairTools({});
  const unavailable = await bare.find(t => t.name === 'chat.optimize_message').execute({});
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.reason, 'body_optimize_unavailable');

  const cancelled = tool.summarizeResult({ ok: true, applied: false, userDecision: 'cancelled' });
  assert.equal(cancelled, 'body optimize cancelled by user in diff preview');
  console.log('ok - chat.optimize_message 工具透传参数、汇总与降级');
}

{
  const { createMaidFormatProfileStore } = await import('../../src/scripts/storage/maid-format-profile-store.js');
  const { buildMaidFormatProfileSourceState } = await import('../../src/scripts/storage/maid-format-profile-evidence-utils.js');
  const storage = (() => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; })();
  const profileStore = createMaidFormatProfileStore({ storage, now: () => 1000 });
  let formatRule = {
    id: 'status-format',
    scriptName: '状态块格式转换',
    findRegex: '/^<status>([\\s\\S]*?)<\\/status>$/g',
    replaceString: '状态块：$1',
    placement: [2],
  };
  const tools = createChatFormatRepairTools({
    formatProfileStore: profileStore,
    resolveSessionId: ({ sessionId, sessionName }) => sessionId || (sessionName === '蒂法' ? '蒂法' : ''),
    resolveFormatProfileSourceState: ({ sources }) => buildMaidFormatProfileSourceState({
      declaredSources: sources,
      presets: [{ type: 'sysprompt', id: 'default', value: { output: 'status' } }],
      regexRules: [formatRule],
      worldbooks: [{ id: '蒂法', updatedAt: 10, entriesCount: 2 }],
    }),
  });
  const saveTool = getTool(tools, 'chat.save_format_profile');
  const readTool = getTool(tools, 'chat.read_format_profile');

  const missing = await readTool.execute({ sessionName: '蒂法' });
  assert.equal(missing.ok, true);
  assert.equal(missing.hasProfile, false);

  // 用户决定（2026-11-20）：保存格式画像前确认；与已存画像完全相同（含来源指纹）时不弹
  const saveArgs = {
    sessionName: '蒂法',
    guide: '回复必须以 <status>...</status> 状态块结尾',
    sources: [{ type: 'worldbook', ref: '蒂法' }],
  };
  const firstPreflight = await saveTool.safety.preflight(saveArgs, {});
  assert.deepEqual([firstPreflight.destructive, firstPreflight.kind, firstPreflight.operationType, firstPreflight.danger],
    [true, 'chat.save_format_profile', 'save_format_profile', false]);
  assert.match(firstPreflight.details.items[0].label, /status/);
  const saved = await saveTool.execute({ ...saveArgs });
  assert.equal(saved.ok, true);
  assert.equal(saved.sessionId, '蒂法');
  assert.equal((await saveTool.safety.preflight({ ...saveArgs }, {})).destructive, false, 'saving the same profile again changes nothing');
  const changedPreflight = await saveTool.safety.preflight({ ...saveArgs, guide: '回复必须以 <status>...</status> 状态块开头' }, {});
  assert.deepEqual([changedPreflight.destructive, changedPreflight.kind, changedPreflight.operationType], [true, firstPreflight.kind, firstPreflight.operationType]);
  assert.equal((await saveTool.safety.preflight({ sessionName: '不存在', guide: '规范内容规范' }, {})).destructive, false, 'a failing save asks nothing');

  const found = await readTool.execute({ sessionName: '蒂法' });
  assert.equal(found.hasProfile, true);
  assert.match(found.profile.guide, /status/);

  formatRule = { ...formatRule, replaceString: '状态：$1（新版）' };
  const stale = await readTool.execute({ sessionName: '蒂法' });
  assert.equal(stale.hasProfile, false, '来源变化后旧自动画像不再作为有效画像返回');
  assert.equal(stale.staleProfile?.sourceChanged, true);
  assert.equal((await saveTool.safety.preflight({ ...saveArgs }, {})).destructive, true, 'refreshing a stale profile is a real change');

  const cleanupOnlyTools = createChatFormatRepairTools({
    formatProfileStore: createMaidFormatProfileStore({ storage: (() => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; })() }),
    resolveSessionId: () => '蒂法',
    resolveFormatProfileSourceState: ({ sources }) => buildMaidFormatProfileSourceState({
      declaredSources: sources,
      regexRules: [{
        id: 'cleanup',
        scriptName: '隐藏思考',
        findRegex: '/<think>[\\s\\S]*?<\\/think>/g',
        replaceString: '',
        placement: [2],
      }],
    }),
  });
  const rejected = await getTool(cleanupOnlyTools, 'chat.save_format_profile').execute({
    guide: '必须输出 <think>...</think>',
    sources: [{ type: 'regex', ref: '隐藏思考' }],
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'regex_format_evidence_untrusted');
  assert.equal((await getTool(cleanupOnlyTools, 'chat.save_format_profile').safety.preflight({
    guide: '必须输出 <think>...</think>',
    sources: [{ type: 'regex', ref: '隐藏思考' }],
  }, {})).destructive, false, 'an untrusted regex-only profile is refused without asking');

  let manualPresetRule = 'A';
  const manualStore = createMaidFormatProfileStore({
    storage: (() => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; })(),
  });
  const manualTools = createChatFormatRepairTools({
    formatProfileStore: manualStore,
    resolveSessionId: () => '蒂法',
    resolveFormatProfileSourceState: ({ sources }) => buildMaidFormatProfileSourceState({
      declaredSources: sources,
      presets: [{ type: 'sysprompt', id: 'manual', value: { output: manualPresetRule } }],
    }),
  });
  const manualGuide = '每条回复末尾必须有 <status>好感度:N</status>';
  const deniedManual = await getTool(manualTools, 'chat.save_format_profile').execute({
    guide: manualGuide,
    manualOverride: true,
  }, { maidUserInput: '帮我记住这个格式' });
  assert.equal(deniedManual.ok, false, '用户没有给出完整 guide 时模型不能伪造手动覆盖');
  assert.equal(deniedManual.reason, 'manual_format_override_not_explicit');

  const savedManual = await getTool(manualTools, 'chat.save_format_profile').execute({
    guide: manualGuide,
    manualOverride: true,
  }, { maidUserInput: `请手动保存这份格式规范：${manualGuide}` });
  assert.equal(savedManual.ok, true);
  assert.equal(manualStore.peek('蒂法')?.manualOverride, true);
  manualPresetRule = 'B';
  const retainedManual = await getTool(manualTools, 'chat.read_format_profile').execute({});
  assert.equal(retainedManual.hasProfile, true);
  assert.equal(retainedManual.profile.manualOverride, true);
  assert.equal(retainedManual.profile.sourceChanged, true);

  const noSession = await saveTool.execute({ sessionName: '不存在', guide: '规范内容规范' });
  assert.equal(noSession.ok, false);
  assert.equal(noSession.reason, 'session_not_found');

  const bare = createChatFormatRepairTools({});
  const unavailable = await getTool(bare, 'chat.read_format_profile').execute({ sessionId: 'x' });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.reason, 'format_profile_store_unavailable');
  console.log('ok - 格式画像保存/读取工具与降级路径');
}

{
  // 修复工具产出 diff 提案、落盘必经 UI 确认——只读意图下允许发起
  const { createChatFormatRepairTools } = await import('../../src/scripts/agent/tools/chat-format-tools.js');
  const repair = createChatFormatRepairTools({}).find(tool => tool.name === 'chat.repair_message_format');
  assert.equal(repair.metadata?.allowInReadOnlyIntent, true);
  assert.equal(repair.capabilities.write, true, '写标记保持真实，白名单只影响只读升级');
  console.log('ok - format repair tool is allowed under read-only intent via metadata flag');
}

console.log('chat-format-tools-tests passed');
