import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { auditPromptData, createPromptAuditAgent, BUILTIN_PROMPT_FIELDS } = await import('../../src/scripts/agent/prompt-audit-agent.js');
const { isBuiltinPromptDefault } = await import('../../src/scripts/ui/prompt-steward-runtime.js');
const { createPromptStewardController, describePromptFinding } = await import('../../src/scripts/ui/prompt-steward-card.js');
const { getCanonicalBuiltinPromptDefaults } = await import('../../src/scripts/storage/preset-store.js');
const { setPromptLocale, getLocalizedPromptText } = await import('../../src/scripts/i18n/prompt-locale.js');

{
  // 字段 → 预设面板卡片的对应，和 preset-panel.js 的 makePromptBlock 一致
  const source = await readFile(new URL('../../src/scripts/ui/preset-panel.js', import.meta.url), 'utf8');
  BUILTIN_PROMPT_FIELDS.forEach(({ key, promptId, title }) => {
    const block = new RegExp(`idPrefix: '${promptId}', title: '${title}',[\\s\\S]{0,400}?rulesKey: '${key}'`);
    assert.match(source, block, `${promptId} maps to ${key}`);
    assert.match(source, new RegExp(`enabledKey: '${key.replace(/_rules$/, '_enabled')}'`), `${key} has the derived enabled key`);
  });
  const defaults = getCanonicalBuiltinPromptDefaults();
  BUILTIN_PROMPT_FIELDS.forEach(({ key }) => assert.equal(typeof defaults[key], 'string', `${key} has a built-in default`));
  console.log('ok - built-in prompt fields match the preset panel cards and have defaults');
}

{
  // 「仍是默认」：原文、翻译后的默认都算；改过一个字就不算
  const defaults = getCanonicalBuiltinPromptDefaults();
  assert.equal(isBuiltinPromptDefault('dialogue_rules', defaults.dialogue_rules), true);
  assert.equal(isBuiltinPromptDefault('dialogue_rules', `${defaults.dialogue_rules}\n\n多加一句`), false);
  assert.equal(isBuiltinPromptDefault('dialogue_rules', defaults.dialogue_rules.replace(/\n/g, '\r\n')), true, 'line endings do not matter');
  setPromptLocale('en');
  const english = getLocalizedPromptText('dialogue_rules', defaults.dialogue_rules);
  if (english !== defaults.dialogue_rules) assert.equal(isBuiltinPromptDefault('dialogue_rules', english), true, 'the translated default counts as default');
  setPromptLocale('zh-CN');
  console.log('ok - edited defaults are detected without counting translated defaults');
}

{
  const record = {
    dialogue_rules: '私聊规则（改过）{{getvar::好感度}}', dialogue_enabled: true,
    group_rules: '群聊规则', group_enabled: false,
    summary_rules: '摘要规则 {{setvar::进度::1}} {{getvar::进度}} {{getvar::角色.心情}}', summary_enabled: true,
    moment_comment_rules: '动态评论规则',
  };
  const report = auditPromptData({
    sysprompt: { presetName: '默认预设', record },
    isDefaultText: key => key !== 'dialogue_rules',
    globalBlocks: [
      { id: 'a', name: '文风', enabled: true, content: '请用第三人称。\n\n保持简洁。' },
      { id: 'b', name: '文风（副本）', enabled: true, content: '请用第三人称。\r\n保持简洁。  ' },
      { id: 'c', name: '抄了摘要', enabled: true, content: '动态评论规则' },
      { id: 'd', name: '关掉的', enabled: false, content: '请用第三人称。\n保持简洁。' },
      { id: 'e', name: '读全局', enabled: true, content: '{{getglobalvar::天气}} {{ifvar::随便::有::没有}}' },
    ],
    globalPlan: { skipped: [
      { id: 'a', name: '文风', reason: 'custom_chat_preset_anchor_skipped', message: '该会话使用自定义预设，此位置未注入' },
      { id: 'x', name: '女仆用', reason: 'request_scope_excluded' },
    ] },
    hasVariable: (name, { global }) => (global ? false : name === '角色.心情'),
  });
  const byType = type => report.findings.filter(item => item.type === type);
  assert.deepEqual(byType('edited_default').map(item => [item.params.title, item.target.promptId]), [['私聊提示词', 'dialogue']], 'disabled built-ins are not checked');
  assert.deepEqual(byType('duplicate_prompts').map(item => [item.params.name, item.params.other, item.params.otherIsBuiltin]), [
    ['文风（副本）', '文风', false], ['抄了摘要', '动态评论回复提示词', true],
  ], 'whitespace differences still count as the same content; disabled blocks are ignored');
  assert.deepEqual(byType('global_skipped').map(item => item.params.reason), ['custom_chat_preset_anchor_skipped'], 'scope exclusions are expected and not reported');
  assert.deepEqual(byType('missing_variable').map(item => [item.params.name, item.params.global, item.params.sources]), [
    ['好感度', false, ['私聊提示词']], ['天气', true, ['读全局']],
  ], 'variables written by the prompts themselves and ifvar checks are not reported');
  assert.equal(report.counts.warnings, 2);
  console.log('ok - the prompt steward flags edited defaults, duplicates, skipped global blocks and missing variables');

  const describe = type => describePromptFinding(report.findings.find(item => item.type === type));
  assert.equal(describe('edited_default').text, '「私聊提示词」改过内置默认（预设「默认预设」）');
  assert.equal(describe('global_skipped').text, '全局提示词「文风」不会加入这个会话：这个会话用的是自定义预设，这个位置不会加入');
  assert.equal(describe('missing_variable').text, '「私聊提示词」读取变量「好感度」，但这个会话目前没有这个变量');
}

{
  // 排进 Agent 运行；卡片：检查中 → 结果 → 「去处理」
  const steps = [];
  const runtime = {
    enqueue: async (run, task) => task({
      runId: 'run-p',
      startStep: (step) => { steps.push({ ...step }); return { id: steps.length - 1 }; },
      finishStep: (id, patch) => Object.assign(steps[id], patch),
    }).then(result => ({ ...result, run })),
  };
  const agent = createPromptAuditAgent({ agentTaskRuntime: runtime, now: () => 5, collect: async () => ({ sysprompt: { presetName: 'P', record: { dialogue_rules: 'x' } }, isDefaultText: () => false }) });
  const result = await agent.auditPrompts({ sessionId: 's1' });
  assert.deepEqual([result.run.kind, result.run.title, result.report.findings.length, result.checkedAt], ['prompt_audit', '提示词检查', 1, 5]);
  assert.deepEqual(steps.map(step => [step.type, step.status]), [['prompt_audit.load', 'succeeded'], ['prompt_audit.analyze', 'succeeded']]);

  const changes = [];
  const opened = [];
  let release;
  const controller = createPromptStewardController({
    documentRef: null,
    getSessionId: () => 's1',
    runAudit: () => new Promise((resolve) => { release = resolve; }),
    openTarget: target => opened.push(target),
    onChange: () => changes.push(controller.renderHtml()),
  });
  assert.match(controller.renderHtml(), /data-prompt-audit-run>/);
  const running = controller.run();
  assert.match(changes.at(-1), /正在检查…/);
  assert.match(changes.at(-1), /data-prompt-audit-run disabled/);
  release({ checkedAt: 0, report: { findings: [{ type: 'edited_default', severity: 'info', params: { title: '私聊提示词', presetName: 'P' }, target: { kind: 'preset_prompt', promptId: 'dialogue' } }] } });
  await running;
  const html = changes.at(-1);
  assert.match(html, /「私聊提示词」改过内置默认/);
  assert.match(html, /data-prompt-audit-target="0"/);
  assert.doesNotMatch(html, /<script/);
  const button = { dataset: { promptAuditTarget: '0' }, listeners: [], addEventListener(type, handler) { this.listeners.push(handler); } };
  controller.bind({ querySelector: () => null, querySelectorAll: () => [button] });
  button.listeners[0]();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(opened, [{ kind: 'preset_prompt', promptId: 'dialogue' }]);
  console.log('ok - the prompt check runs as an agent run and the card links each finding to where it is fixed');
}

{
  // Agent Center「提示词」页把卡片放在最上面
  const source = await readFile(new URL('../../src/scripts/ui/agent-center-panel.js', import.meta.url), 'utf8');
  assert.match(source, /renderPromptModules\(\) \{\s*return `\$\{this\.promptSteward\?\.renderHtml\?\.\(\) \|\| ''\}/);
  assert.match(source, /if \(this\.activeTab === 'prompts'\) this\.promptSteward\?\.bind\?\.\(this\.contentElement\);/);
  console.log('ok - the agent center prompts tab hosts the steward card');
}

console.log('prompt-steward-tests passed');
