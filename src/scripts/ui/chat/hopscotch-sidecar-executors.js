import { t } from '../../i18n/index.js';
import { cloneData } from '../../utils/clone-data.js';
import { AUTO_IMAGE_PROMPT_TAG, buildAutoImagePromptInstruction, extractAutoImagePrompts } from './auto-image-prompt-utils.js';
import { extractUpdateVariableBlocks } from './update-variable-block-utils.js';
import { buildUpdateVariableParser } from './update-variable-parser-utils.js';

const rawText = message => String(message?.rawOriginal || message?.rawSource || message?.content || '');
const abort = () => { throw Object.assign(new Error('Task target changed'), { name: 'AbortError' }); };
const textOf = response => typeof response === 'string' ? response : String(response?.content ?? response?.text ?? '');
const UPDATE_CONTRACT = /<\s*\/?\s*(?:UpdateVariable|variableupdate|json_patch)\b|\b_\.(?:set|add|assign|remove|insert)\s*\(|\b(?:JSONPatch|JSON\s*Patch)\b/i;

export const buildHopscotchImagePromptMessages = ({ imageSettings = {}, imageInstruction = buildAutoImagePromptInstruction({ uiMode:'rp', ...imageSettings }), userInput = '', body = '', renderMacros = value => value } = {}) => [
  { role:'system', content:renderMacros(imageInstruction) + '\n' + t('为给定正文生成图片提示。只输出 <{tag}> 标签；无需配图时输出 <{tag}>none</{tag}>。', { tag:AUTO_IMAGE_PROMPT_TAG }) },
  { role:'user', content:`${userInput}\n\n${body}` },
];

// 图片提示房子卡片「套用预设」的预览／试运行：用最近一轮的输入与正文，按卡片当前（未保存）的模型设置组请求；不写入。
export const createImagePromptHousePresetHandler = ({
  getSessionId = () => '', getMessages = () => [], resolvePreset = () => ({ ok: false }),
  backgroundChat = null, getRuntimeConfigByProfileId = null,
} = {}) => {
  const prepare = async ({ presetId = '', context = {} } = {}) => {
    const sessionId = String(getSessionId() || '').trim();
    if (!sessionId) return { error: '请先打开一个会话' };
    if (typeof backgroundChat !== 'function') return { error: '还没有配置可用的模型' };
    const taskPreset = resolvePreset(presetId, sessionId);
    if (!taskPreset?.ok) return { error: '所选预设已不存在' };
    const all = (getMessages(sessionId) || []).filter(m => m && (m.role === 'user' || m.role === 'assistant'));
    let lastUser = -1;
    all.forEach((m, i) => { if (m.role === 'user') lastUser = i; });
    const body = String(all.slice(lastUser + 1).find(m => m.role === 'assistant')?.content || '');
    if (!body.trim()) return { error: '还没有可以配图的正文' };
    const userInput = lastUser >= 0 ? String(all[lastUser].content || '') : '';
    const rendered = taskPreset.render([{ role: 'user', content: `${userInput}\n\n${body}`, source: '本轮输入与正文' }]);
    if (!rendered?.ok || !rendered.messages.length) return { error: '这个预设组不出请求' };
    const cfg = context?.config || {};
    const options = { maxTokens: 4096, tools: [], presetContext: { sessionId, uiMode: 'rp', presetId: taskPreset.id } };
    if (cfg.modelMode === 'profile' && cfg.modelProfileId) {
      const config = await getRuntimeConfigByProfileId?.(cfg.modelProfileId);
      if (!config) return { error: '指定的模型配置不存在' };
      options.runtimeConfigOverride = cfg.modelOverride ? { ...config, model: cfg.modelOverride } : config;
    }
    return { messages: rendered.messages.map(({ role, content }) => ({ role, content })), options };
  };
  return {
    preview: async (input = {}) => {
      const prepared = await prepare(input);
      if (prepared.error) return { ok: false, message: prepared.error };
      const result = await backgroundChat(prepared.messages, { ...prepared.options, previewOnly: true });
      return { ok: true, messages: result?.messages || prepared.messages };
    },
    trial: async ({ signal = null, ...input } = {}) => {
      const prepared = await prepare(input);
      if (prepared.error) return { ok: false, message: prepared.error };
      const startedAt = Date.now();
      const text = textOf(await backgroundChat(prepared.messages, { ...prepared.options, ...(signal ? { signal } : {}) })).trim();
      if (!text) return { ok: false, message: '模型返回为空' };
      const prompts = extractAutoImagePrompts(text, { max: 10, maxLength: 2000 });
      return prompts.length
        ? { ok: true, text, message: t('读到 {count} 条图片提示', { count: prompts.length }), latencyMs: Date.now() - startedAt }
        : { ok: false, text, message: t('没读到 {tag}：请确认预设要求把图片提示写在这个标签里', { tag: `<${AUTO_IMAGE_PROMPT_TAG}>` }), latencyMs: Date.now() - startedAt };
    },
  };
};

// 每轮一份依赖快照；只负责正文之外的请求和变量落地，不操作 UI 或重新进入发送链。
export const createHopscotchSidecarExecutors = ({
  sessionId, userInput = '', board, getTurnContext, runtimeConfig,
  backgroundChat, getProfileConfig, getMessage, getScope, hasSession, getVariables, getSchemas,
  isVariableEnabled, applyVariables, checkpointVariables, ruleEngine, useGlobalVariables = false,
  promptSources = [], imageSettings = {}, renderMacros = value => value,
  imageEligibility = () => ({ ok: true }),
  // 「套用预设」：按预设 id 解析（agent-task-preset.js 的 resolve 结果）
  resolveTaskPreset = null,
} = {}) => {
  const scope = getScope();
  const rules = cloneData(ruleEngine?.getRules(sessionId) || []);
  const contracts = promptSources.filter(text => UPDATE_CONTRACT.test(String(text || ''))).join('\n\n');
  const imageInstruction = buildAutoImagePromptInstruction({ uiMode: 'rp', ...cloneData(imageSettings) });
  const profiles = new Map();
  for (const house of board.rows.flatMap(row => row.houses)) {
    if (!['variable', 'image_prompt'].includes(house.kind)) continue;
    if (house.config?.modelMode === 'profile' && house.config.modelProfileId) {
      const id = house.config.modelProfileId;
      if (!profiles.has(id)) profiles.set(id, Promise.resolve(getProfileConfig?.(id)).then(config => config ? { ...config } : null).catch(() => null));
    }
  }
  const current = signal => !signal?.aborted && getScope() === scope && hasSession(sessionId);
  const target = signal => {
    if (!current(signal)) abort();
    const messageId = getTurnContext()?.body?.messageId;
    const message = getMessage(messageId, sessionId);
    if (!message || message.role !== 'assistant') return null;
    const source = rawText(message), swipe = message.meta?.activeSwipe || 0;
    const canCommit = () => {
      const latest = getMessage(messageId, sessionId);
      return current(signal) && latest?.role === 'assistant' && rawText(latest) === source && (latest.meta?.activeSwipe || 0) === swipe;
    };
    return { messageId, message: cloneData(message), source, canCommit };
  };
  const request = async (house, messages, signal, { presetId = '' } = {}) => {
    if (!current(signal)) abort();
    const cfg = house.config || {};
    let config = runtimeConfig ? { ...runtimeConfig } : null;
    if (cfg.modelMode === 'profile') {
      config = await profiles.get(cfg.modelProfileId);
      if (!config) throw new Error(t('指定的模型配置不存在'));
    }
    if (!current(signal)) abort();
    if (cfg.modelOverride) config = { ...config, model: cfg.modelOverride };
    let usage = null;
    const startedAt = Date.now();
    const response = await backgroundChat(messages, {
      signal, maxTokens: 4096, tools: [], presetContext: { sessionId, uiMode: 'rp', ...(presetId ? { presetId } : {}) },
      ...(config ? { runtimeConfigOverride: config } : {}), onProviderUsage: value => { usage = value; },
    });
    if (!current(signal)) abort();
    return { text: textOf(response).trim(), usage: { latencyMs: Date.now() - startedAt, providerUsage: usage || response?.usage || null } };
  };
  const parser = buildUpdateVariableParser();
  return {
    image_prompt: { run: async ({ house, signal }) => {
      const body = target(signal);
      if (!body) return { status: 'skipped', reason: 'body_message_missing' };
      const eligibility = imageEligibility({ sessionId, messageId: body.messageId });
      if (!eligibility.ok) return { status: 'skipped', reason: eligibility.reason || 'cadence' };
      // 套用预设：本轮输入与正文放在预设的聊天记录位置，<image_prompt> 要求由预设写；预设没了退回内建规则。
      const taskPreset = house.config?.promptSource === 'preset' && house.config?.presetId ? resolveTaskPreset?.(house.config.presetId) : null;
      const rendered = taskPreset?.ok ? taskPreset.render([{ role: 'user', content: `${userInput}\n\n${body.source}`, source: '本轮输入与正文' }]) : null;
      const messages = rendered?.ok
        ? rendered.messages.map(({ role, content }) => ({ role, content }))
        : buildHopscotchImagePromptMessages({ imageInstruction, userInput, body:body.source, renderMacros });
      const result = await request(house, messages, signal, rendered?.ok ? { presetId: taskPreset.id } : {});
      if (!body.canCommit()) abort();
      const prompts = extractAutoImagePrompts(result.text, { max: imageSettings.maxCount || 10, maxLength: imageSettings.maxLength || 2000 });
      if (!prompts.length) {
        if (/<image_prompt>\s*(none|null|n\/a|无|不需要)?\s*<\/image_prompt>/i.test(result.text)) return { status: 'skipped', reason: 'no_prompt', usage: result.usage };
        throw new Error(t('模型未返回有效的图片提示'));
      }
      return { status: 'succeeded', usage: result.usage, artifact: { kind: 'image_prompt', sourceMessageId: body.messageId, sourceText: body.source, prompts, text: prompts.map(prompt => `<${AUTO_IMAGE_PROMPT_TAG}>${prompt}</${AUTO_IMAGE_PROMPT_TAG}>`).join('\n') } };
    } },
    variable: { run: async ({ house, signal }) => {
      if (!isVariableEnabled(sessionId)) return { status: 'skipped', reason: 'variable_runtime_disabled' };
      const body = target(signal);
      if (!body) return { status: 'skipped', reason: 'body_message_missing' };
      if (!contracts.trim()) return { status: 'skipped', reason: 'no_variable_updates' };
      const variables = JSON.stringify(getVariables()), schemas = JSON.stringify(getSchemas());
      const result = await request(house, [
        { role: 'system', content: renderMacros(contracts) + '\n\n' + t('依据本轮正文和变量规则更新当前变量。只输出完整的 {open} 块，使用规则约定的命令或 JSONPatch；无变化时输出 {empty}。', { open: '<UpdateVariable>', empty: '<UpdateVariable>[]</UpdateVariable>' }) },
        { role: 'user', content: `Current variables:\n${variables}\nSchema:\n${schemas}\nUser:\n${userInput}\nAssistant:\n${body.source}` },
      ], signal);
      if (!body.canCommit() || !isVariableEnabled(sessionId)) abort();
      if (variables !== JSON.stringify(getVariables()) || schemas !== JSON.stringify(getSchemas())) throw new Error(t('变量已发生变化，请重新执行'));
      const opened = (result.text.match(/<\s*(?:UpdateVariable|variableupdate)\b[^>]*>/gi) || []).length;
      const closed = (result.text.match(/<\s*\/(?:UpdateVariable|variableupdate)\s*>/gi) || []).length;
      if (!opened || opened !== closed) throw new Error(t('模型未返回完整的变量更新'));
      const blocks = extractUpdateVariableBlocks(result.text).blocks;
      const commands = blocks.flatMap(block => parser.parseCommands(block));
      if (!commands.length && !blocks.every(block => /^\s*(?:\[\s*\])?\s*$/.test(block))) throw new Error(t('模型未返回有效的变量更新'));
      const changed = commands.length ? applyVariables(commands) : false;
      if (changed) await checkpointVariables(body.messageId);
      return { status: 'succeeded', usage: result.usage, artifact: { kind: 'variable', payload: { changed: Boolean(changed), commandCount: commands.length } } };
    } },
    variable_rules: { run: async ({ house, signal }) => {
      if (!isVariableEnabled(sessionId)) return { status: 'skipped', reason: 'variable_runtime_disabled' };
      if (!current(signal)) abort();
      const before = house.config.phase === 'before';
      const body = before ? null : target(signal);
      if (!before && !body) return { status: 'skipped', reason: 'body_message_missing' };
      const canCommit = () => current(signal) && isVariableEnabled(sessionId) && (!body || body.canCommit());
      const execution = { signal, canCommit, strict: true, rulesOverride: rules,
        requestOptions: { ...(runtimeConfig ? { runtimeConfigOverride: { ...runtimeConfig } } : {}), presetContext: { sessionId, uiMode: 'rp' }, tools: [] } };
      const valuesBefore = JSON.stringify(getVariables());
      let result;
      try {
        result = before
          ? await ruleEngine?.handleBeforeSend({ sessionId, content: userInput, useGlobalVariables, execution })
          : await ruleEngine?.handleAfterReceive({ sessionId, message: body.message, useGlobalVariables, execution });
      } finally {
        if (body && canCommit() && valuesBefore !== JSON.stringify(getVariables())) await checkpointVariables(body.messageId);
      }
      if (!canCommit()) abort();
      return result?.executed ? { status: 'succeeded', artifact: { kind: 'variable_rules', payload: { executed: result.executed, phase: house.config.phase } } } : { status: 'skipped', reason: 'rule_not_triggered' };
    } },
  };
};
