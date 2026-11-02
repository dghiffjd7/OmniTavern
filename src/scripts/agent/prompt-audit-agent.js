// 提示词管家（Agent 资源中心计划 P5）：只读、只用规则检查当前会话会用到的提示词，不调模型、不修改。
// 查：改过的内置默认（不判断新旧：内置默认没有版本号）、全局提示词块之间或与内置提示词内容重复、
// 读取了不存在的变量、启用了却不会注入的全局提示词块。第三方预设的条目不查（预设种类太多，交给用户）。
// finding：{ type, severity: 'warning'|'info', params, target }，target 给界面「去处理」用。

const trim = value => String(value ?? '').trim();

// 预设面板「系统提示词」页的内置提示词卡：字段 → 卡片 id 与标题（与 preset-panel.js 的 makePromptBlock 对应，测试会核对）
export const BUILTIN_PROMPT_FIELDS = Object.freeze([
  { key: 'phone_format_intro_rules', promptId: 'phone-format-intro', title: '手机格式开头' },
  { key: 'phone_format_chat_rules', promptId: 'phone-format-chat', title: 'QQ聊天格式' },
  { key: 'phone_format_moment_rules', promptId: 'phone-format-moment', title: 'QQ空间格式' },
  { key: 'phone_format_footer_rules', promptId: 'phone-format-footer', title: '手机格式结尾' },
  { key: 'dialogue_rules', promptId: 'dialogue', title: '私聊提示词' },
  { key: 'moment_create_rules', promptId: 'moment', title: '动态发布决策提示词' },
  { key: 'moment_comment_rules', promptId: 'moment-comment', title: '动态评论回复提示词' },
  { key: 'moment_publish_comment_rules', promptId: 'moment-publish-comment', title: '发布后评论提示词' },
  { key: 'auto_image_prompt_rules', promptId: 'auto-image-prompt', title: '自动标签生图提示词' },
  { key: 'group_rules', promptId: 'group', title: '群聊提示词' },
  { key: 'summary_rules', promptId: 'summary', title: '摘要提示词' },
]);

const enabledKeyOf = key => key.replace(/_rules$/, '_enabled');
const normalizeText = value => String(value ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();

// 读变量：getvar／var／getglobalvar（ifvar 本来就是判断有没有，不算）
const READ_RE = /\{\{\s*(getvar|var|getglobalvar)\s*::\s*([^:}]+?)\s*(?:::[^}]*)?\}\}/gi;
const WRITE_RE = /\{\{\s*(setvar|addvar|incvar|decvar|setglobalvar|addglobalvar|incglobalvar|decglobalvar)\s*::\s*([^:}]+?)\s*(?:::|\}\})/gi;
const collectVariables = (text, re) => [...String(text || '').matchAll(re)].map(match => ({ global: /global/i.test(match[1]), name: trim(match[2]) }));

/**
 * sysprompt：{ presetName, record }（当前会话的系统提示词预设）；isDefaultText(key, text) 判断是否仍是内置默认（含翻译后的默认）；
 * globalBlocks：全局提示词库的块；globalPlan：resolveGlobalSemanticPromptPlan 的结果；hasVariable(name, { global }) 判断变量是否存在。
 */
export const auditPromptData = ({
  sysprompt = null,
  isDefaultText = () => true,
  globalBlocks = [],
  globalPlan = null,
  hasVariable = () => true,
} = {}) => {
  const findings = [];
  const record = sysprompt?.record && typeof sysprompt.record === 'object' ? sysprompt.record : {};
  const presetName = trim(sysprompt?.presetName);

  // 当前会话会用到的内置提示词（只看启用的）
  const builtins = BUILTIN_PROMPT_FIELDS
    .filter(field => typeof record[field.key] === 'string' && trim(record[field.key]) && record[enabledKeyOf(field.key)] !== false)
    .map(field => ({ ...field, text: record[field.key] }));
  builtins.forEach((field) => {
    if (isDefaultText(field.key, field.text)) return;
    findings.push({ type: 'edited_default', severity: 'info', params: { title: field.title, presetName },
      target: { kind: 'preset_prompt', promptId: field.promptId } });
  });

  // 全局提示词块：启用的聊天块
  const blocks = (Array.isArray(globalBlocks) ? globalBlocks : []).filter(block => block?.enabled !== false && trim(block?.content));
  const seen = new Map();
  builtins.forEach(field => seen.set(normalizeText(field.text), { name: field.title, builtin: true }));
  blocks.forEach((block) => {
    const key = normalizeText(block.content);
    const other = seen.get(key);
    if (other) {
      findings.push({ type: 'duplicate_prompts', severity: 'warning', params: { name: trim(block.name) || trim(block.id), other: other.name, otherIsBuiltin: other.builtin === true },
        target: { kind: 'global_prompts' } });
    } else seen.set(key, { name: trim(block.name) || trim(block.id) });
  });

  // 启用了却不会注入当前会话的全局块（原因来自注入计划本身）
  const skipped = Array.isArray(globalPlan?.skipped) ? globalPlan.skipped : [];
  skipped.filter(item => item?.reason && item.reason !== 'request_scope_excluded').forEach((item) => {
    findings.push({ type: 'global_skipped', severity: 'info', params: { name: trim(item.name) || trim(item.id), reason: trim(item.reason), message: trim(item.message) },
      target: { kind: 'global_prompts' } });
  });

  // 读取了不存在的变量：同一批提示词里会写入的不算
  const sources = [
    ...builtins.map(field => ({ name: field.title, text: field.text })),
    ...blocks.map(block => ({ name: trim(block.name) || trim(block.id), text: block.content })),
  ];
  const written = new Set(sources.flatMap(source => collectVariables(source.text, WRITE_RE)).map(item => `${item.global}:${item.name}`));
  const missing = new Map();
  sources.forEach((source) => {
    collectVariables(source.text, READ_RE).forEach((item) => {
      const key = `${item.global}:${item.name}`;
      if (!item.name || written.has(key) || hasVariable(item.name, { global: item.global })) return;
      if (!missing.has(key)) missing.set(key, { name: item.name, global: item.global, sources: [] });
      if (!missing.get(key).sources.includes(source.name)) missing.get(key).sources.push(source.name);
    });
  });
  missing.forEach(item => findings.push({ type: 'missing_variable', severity: 'info', params: item, target: { kind: 'variables' } }));

  return {
    counts: {
      builtins: builtins.length,
      globalBlocks: blocks.length,
      warnings: findings.filter(item => item.severity === 'warning').length,
      infos: findings.filter(item => item.severity === 'info').length,
    },
    findings,
  };
};

export const createPromptAuditAgent = ({ agentTaskRuntime = null, collect = async () => ({}), now = Date.now } = {}) => ({
  auditPrompts: (request = {}) => {
    if (typeof agentTaskRuntime?.enqueue !== 'function') return Promise.reject(new Error('agent task runtime not configured'));
    const sessionId = trim(request?.sessionId);
    return agentTaskRuntime.enqueue({
      kind: 'prompt_audit',
      title: '提示词检查',
      sessionId,
      source: 'prompt-check',
      trigger: trim(request?.source, 'manual'),
      summary: '只读检查当前会话会用到的提示词',
      metadata: { sessionId },
    }, async ({ runId, startStep, finishStep }) => {
      const loadStep = startStep({ type: 'prompt_audit.load', summary: '读取提示词' });
      let data;
      try {
        data = await collect({ sessionId });
      } catch (error) {
        finishStep(loadStep.id, { status: 'failed', errorMessage: String(error?.message || error) });
        throw error;
      }
      finishStep(loadStep.id, { status: 'succeeded', output: { presetName: trim(data?.sysprompt?.presetName) } });
      const analyzeStep = startStep({ type: 'prompt_audit.analyze', summary: '检查提示词' });
      const report = auditPromptData(data);
      finishStep(analyzeStep.id, { status: 'succeeded', output: { counts: report.counts, findingCount: report.findings.length } });
      return { runId, status: 'succeeded', report, checkedAt: now() };
    });
  },
});
