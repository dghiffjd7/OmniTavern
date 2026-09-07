import { t } from '../../i18n/index.js';
import { AUTO_IMAGE_PROMPT_TAG, buildAutoImagePromptInstruction, extractAutoImagePrompts } from './auto-image-prompt-utils.js';
import { extractUpdateVariableBlocks } from './update-variable-block-utils.js';
import { buildUpdateVariableParser } from './update-variable-parser-utils.js';

const rawText = message => String(message?.rawOriginal || message?.rawSource || message?.content || '');
const abort = () => { throw Object.assign(new Error('Task target changed'), { name: 'AbortError' }); };
const textOf = response => typeof response === 'string' ? response : String(response?.content ?? response?.text ?? '');
const UPDATE_CONTRACT = /<\s*\/?\s*(?:UpdateVariable|variableupdate|json_patch)\b|\b_\.(?:set|add|assign|remove|insert)\s*\(|\b(?:JSONPatch|JSON\s*Patch)\b/i;

// 每轮一份依赖快照；只负责正文之外的请求和变量落地，不操作 UI 或重新进入发送链。
export const createHopscotchSidecarExecutors = ({
  sessionId, userInput = '', board, getTurnContext, runtimeConfig,
  backgroundChat, getProfileConfig, getMessage, getScope, hasSession, getVariables, getSchemas,
  isVariableEnabled, applyVariables, checkpointVariables, ruleEngine, useGlobalVariables = false,
  promptSources = [], imageSettings = {}, renderMacros = value => value,
  imageEligibility = () => ({ ok: true }),
} = {}) => {
  const scope = getScope();
  const rules = structuredClone(ruleEngine?.getRules(sessionId) || []);
  const contracts = promptSources.filter(text => UPDATE_CONTRACT.test(String(text || ''))).join('\n\n');
  const imageInstruction = buildAutoImagePromptInstruction({ uiMode: 'rp', ...structuredClone(imageSettings) });
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
    return { messageId, message: structuredClone(message), source, canCommit };
  };
  const request = async (house, messages, signal) => {
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
      signal, maxTokens: 4096, tools: [], presetContext: { sessionId, uiMode: 'rp' },
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
      const result = await request(house, [
        { role: 'system', content: renderMacros(imageInstruction) + '\n' + t('为给定正文生成图片提示。只输出 <{tag}> 标签；无需配图时输出 <{tag}>none</{tag}>。', { tag: AUTO_IMAGE_PROMPT_TAG }) },
        { role: 'user', content: `${userInput}\n\n${body.source}` },
      ], signal);
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
