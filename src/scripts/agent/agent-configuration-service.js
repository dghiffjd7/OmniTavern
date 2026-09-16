import { BODY_SELECTOR_ID, createTextAgentId, createInputAgentId, normalizeAgentConfiguration } from '../storage/agent-config-store.js';
import { allowsAgentInvocation, isInputAgent } from './agent-invocation.js';
import { resolveAgentTextTargetAsync, suggestAgentBodyRules } from './agent-text-target.js';
import { buildTextEditRequest, buildAgentNoteRequest, buildAgentReferenceContext } from './agent-request-builder.js';
import { buildInputAgentRequest } from './input-agent-runtime.js';

export const createAgentConfigurationService = ({ store, getContext, getMessages, getRaw, getEvidence = () => [], getProfiles,
  getInput = () => ({ before: '', after: '' }), getInputRuntime = () => null, buildInputPreview = null,
  buildFormatPreview, previewRequest = null, runtime, runFormat, resolveReference = null, listReferenceSources = async () => [], listAvailableTools = async () => [], resolveTarget = resolveAgentTextTargetAsync, getCurrentModelLabel = () => '', onChanged = () => {} } = {}) => {
  const context = options => options?.context || getContext();
  const checkContext = c => { const current = getContext(); return current.place === c.place && current.scopeId === c.scopeId && (!c.sessionId || current.sessionId === c.sessionId) && (c.archiveId === undefined || c.archiveId === current.archiveId); };
  const read = (options = {}) => {
    const c = context(options), scope = options.scope === 'global' ? 'global' : 'local';
    const result = store.read(options.id, c, scope), body = store.read(BODY_SELECTOR_ID, c, scope);
    return { ...result, context: { ...result.context, ...(c.archiveId !== undefined ? { archiveId: c.archiveId } : {}) }, bodyRule: body.config?.target || { mode: 'tags', start: '', end: '' }, bodyRevision: body.revision,
      profiles: getProfiles().map(p => ({ id: p.id, name: p.name || p.label || p.id, model: p.model || '' })) };
  };
  const source = async options => {
    const c = context(options), messages = getMessages(c.sessionId) || [];
    const message = options.messageId ? messages.find(m => m.id === options.messageId)
      : [...messages].reverse().find(m => m.role === 'assistant' && (!m.type || m.type === 'text') && !m.error && !m.pending && !['pending', 'sending'].includes(m.status) && !m.meta?.generatedMedia);
    const raw = message ? await getRaw(message, c.sessionId) : '';
    return { message, raw, messages: message ? messages.slice(0, messages.findIndex(m => m.id === message.id)) : [] };
  };
  const buildPrompt = async options => {
      const c = context(options), saved = read(options), config = options.config || saved.config;
      if (isInputAgent(config) && buildInputPreview) return buildInputPreview(config, c);
      if (config.kind === 'input_suggestion') {
        const reference = resolveReference ? await resolveReference({ config: config.context, context: c }) : buildAgentReferenceContext(getMessages(c.sessionId), config.context);
        const input = getInput(), before = String(input.before || ''), after = String(input.after || '');
        return { ...buildInputAgentRequest(config, { text:before + after, start:before.length, end:before.length }, reference),
          previewNote: reference.truncated ? '参考上下文已截断；光标前后保留 2400 / 600 字符' : '光标前后保留 2400 / 600 字符' };
      }
      if (config.kind === 'format_review') return buildFormatPreview({ ...options, context: c, config });
      const { raw, messages, message } = await source(options);
      const target = await resolveTarget(raw, config.target, { bodyRule: options.bodyRule || saved.bodyRule, selection: options.selection, message, context: c, readOnly: config.outputMode === 'note' });
      if (!target.ok) return { messages: [], previewNote: target.message };
      const referenceContext = resolveReference ? await resolveReference({ config: config.context, context: c, targetMessageId: message?.id })
        : buildAgentReferenceContext(getMessages(c.sessionId),config.context,{targetMessageId:message?.id});
      return (config.outputMode === 'note' ? buildAgentNoteRequest : buildTextEditRequest)({ config, target, referenceContext });
  };
  const actions = {
    getAgentConfiguration: read,
    getAgentCurrentModelLabel: options => getCurrentModelLabel(context(options)),
    listAgentReferenceSources: async options => {
      const c = context(options); if (!checkContext(c)) return [];
      const config = options.config || read(options).config;
      const rows = await listReferenceSources(c, { config: config.context, worldbookId: options.worldbookId });
      return checkContext(c) ? rows.map(({text, ...row}) => ({...row, chars: row.chars ?? String(text || '').length})) : [];
    },
    listAgentAvailableTools: async options => { const c = context(options); if (!checkContext(c)) return [];
      const rows = await listAvailableTools({ ...options, context: c, config: options.config || read(options).config });
      return checkContext(c) ? rows : [];
    },
    previewAgentReferenceContext: async options => {
      const c = context(options), config = options.config || read(options).config;
      if (!checkContext(c)) throw Object.assign(new Error('当前角色或存档已变化，请重新打开'), { name: 'AbortError' });
      const messages = getMessages(c.sessionId) || [];
      const message = isInputAgent(config) ? null : options.messageId ? messages.find(item => item.id === options.messageId)
        : [...messages].reverse().find(item => item.role === 'assistant' && (!item.type || item.type === 'text') && !item.error && !item.pending && !['pending', 'sending'].includes(item.status) && !item.meta?.generatedMedia);
      const targetMessageId = isInputAgent(config) ? '' : options.messageId || message?.id || '';
      const result = resolveReference ? await resolveReference({config:config.context, context:c, targetMessageId})
        : buildAgentReferenceContext(messages,config.context,{targetMessageId});
      if (!checkContext(c)) throw Object.assign(new Error('当前角色或存档已变化，请重新打开'), { name: 'AbortError' });
      return result;
    },
    listAgentConfigurations: options => store.list(context(options), options?.scope),
    saveAgentConfiguration: async options => {
      if (!checkContext(context(options))) return { ok: false, reason: 'context_changed' };
      const config = normalizeAgentConfiguration(options.config, options.id);
      if (config.enabled && (config.modelMode === 'none' || (config.modelMode === 'profile' && !config.modelProfileId))) return { ok: false, message: '请先选择模型' };
      if (config.enabled && isInputAgent(config) && config.modelMode !== 'profile') return { ok: false, message: '输入建议请选择独立模型配置' };
      if (config.enabled && config.kind === 'input_agent' && !config.prompt.trim()) return { ok: false, message: '请填写任务要求' };
      if (config.enabled && config.id === 'reply_check' && context(options).place === 'writing' && !config.formatGuide.trim()) return { ok: false, message: '请先填写格式要求' };
      if (config.enabled && config.kind === 'text_edit' && !config.prompt.trim()) return { ok: false, message: '请填写任务要求' };
      if (config.enabled && config.kind === 'text_edit') {
        const rule = config.target.mode === 'body' ? options.bodyRule || store.read(BODY_SELECTOR_ID, context(options), options.scope).config?.target : config.target;
        if (!rule || rule.mode === 'body' || (rule.mode === 'tags' && (!rule.start || !rule.end)) || (rule.mode === 'regex' && !rule.pattern))
          return { ok: false, message: '请先设置完整的处理范围' };
      }
      const result = await store.save({ ...options, context: context(options), config });
      if (result.ok) onChanged();
      return result;
    },
    resetAgentConfiguration: options => {
      if (!checkContext(context(options))) return { ok: false, reason: 'context_changed' };
      if (/^(text-edit|input-agent):/.test(options.id) && options.scope !== 'global' && !store.read(options.id, context(options), 'global').config)
        return { ok: false, message: '此 Agent 暂无全局配置' };
      return store.reset({ ...options, context: context(options) });
    },
    removeAgentConfiguration: options => checkContext(context(options)) ? store.remove({ ...options, context: context(options) }) : { ok: false, reason: 'context_changed' },
    createTextEditAgent: async (options = {}) => {
      const id = createTextAgentId(), c = context(options);
      if (!checkContext(c)) return { ok: false, reason: 'context_changed' };
      if (store.list(c, options.scope).filter(item => item.config.kind === 'text_edit').length >= 8) return { ok: false, reason: 'agent_limit', message: '当前范围最多 8 个回复 Agent' };
      const config = normalizeAgentConfiguration({ title: '正文润色', prompt: '润色正文，保留事实、人物语气和原意。',
        context: { history: { enabled: false, unit: 'turns', count: 3, includeTarget: true } }, invocationMode: 'auto', modelMode: 'follow_current', target: { mode: 'rendered' }, ...options.config, enabled: false }, id);
      const result = await store.save({ id, context: c, scope: options.scope || 'local', config });
      return { ...result, id };
    },
    createInputAgent: async (options = {}) => {
      const id = createInputAgentId(), c = context(options);
      if (!checkContext(c)) return { ok: false, reason: 'context_changed' };
      const config = normalizeAgentConfiguration({ title: '输入助手', prompt: '根据用户的草稿，给出简短、有用的写作建议。', inputOutput: 'note', context: { history: { enabled: false, unit: 'turns', count: 3, includeTarget: true } }, invocationMode: 'auto', ...options.config, enabled: false }, id);
      const result = await store.save({ id, context: c, scope: options.scope || 'local', config });
      return { ...result, id };
    },
    copyAgentConfiguration: async options => {
      const c = context(options), target = options.targetContext;
      if (!target || !checkContext(c)) return { ok: false, reason: 'invalid_context' };
      const original = options.config || store.read(options.id, c, options.scope).config;
      const id = original?.kind === 'text_edit' ? createTextAgentId() : original?.kind === 'input_agent' ? createInputAgentId() : options.id;
      const scope = options.targetScope || 'global';
      if (!original) return { ok: false, reason: 'agent_missing' };
      if (original.kind === 'text_edit' && store.list(target, scope).filter(item => item.config.kind === 'text_edit').length >= 8) return { ok: false, reason: 'agent_limit' };
      return store.save({ id, context: target, scope, revision: store.read(id, target, scope).revision, config: { ...original, id, enabled: false } });
    },
    getAgentTargetPreview: async options => {
      const { raw, message } = await source(options);
      const saved = read(options);
      const target = options.config?.target || saved.config?.target || { mode: 'body' };
      return { raw, messageId: message?.id || '', target: await resolveTarget(raw, target, { bodyRule: options.bodyRule || saved.bodyRule, selection: options.selection, message, context: context(options), readOnly: (options.config || saved.config)?.outputMode === 'note' }),
        suggestions: suggestAgentBodyRules(raw, getEvidence(context(options).sessionId)) };
    },
    buildAgentConfigurationPreview: async options => {
      const c = context(options), config = options.config || read(options).config;
      if (!checkContext(c)) throw new Error('当前角色或存档已变化，请重新打开');
      let request = await buildPrompt(options);
      if (previewRequest && request?.messages?.length && config.kind !== 'format_review') request = await previewRequest({ request,config,context:c });
      if (!checkContext(c)) throw new Error('当前角色或存档已变化，请重新打开');
      return request;
    },
    listTextEditRuns: () => runtime.list(),
    listInputAgentRuns: () => getInputRuntime()?.list() || [],
    runConfiguredInputAgent: options => {
      const c = context(options), config = store.read(options.id, c, options.scope).config;
      if (!checkContext(c) || !allowsAgentInvocation(config, 'manual')) return { status: 'skipped', reason: '此 Agent 尚未允许手动调用' };
      return getInputRuntime()?.run({ agentId: options.id, invocation: 'manual', target: options.inputTarget, expectedContext: c, scope: options.scope }) || { status: 'skipped', reason: '输入框暂不可用' };
    },
    applyInputAgentRun: id => getInputRuntime()?.apply(id),
    cancelInputAgentRun: id => getInputRuntime()?.cancel(id),
    ignoreInputAgentRun: id => getInputRuntime()?.ignore(id),
    runTextEditAgent: async options => {
      if (!checkContext(context(options))) return { status: 'failed', reason: '当前角色已变化，请重新打开' };
      const c = context(options), { message, raw } = await source(options);
      if (!checkContext(c)) return { status: 'failed', reason: '当前角色已变化，请重新打开' };
      if (!message) return { status: 'failed', reason: '暂无可处理的回复' };
      const saved = read(options);
      if (!allowsAgentInvocation(saved.config, 'manual')) return { status: 'skipped', reason: '此 Agent 尚未允许手动调用' };
      let selection = options.selection;
      if (options.selectedText) {
        const start = raw.indexOf(options.selectedText);
        if (start < 0 || start !== raw.lastIndexOf(options.selectedText)) return { status: 'skipped', reason: '选中文字无法唯一定位，请在 Agent 配置中选取原文' };
        selection = { start, end: start + options.selectedText.length, text: options.selectedText };
      }
      return runtime.run({ agentId: options.id, sessionId: c.sessionId, messageId: message.id, selection, force: true,
        configOverride: saved.config, bodyRuleOverride: saved.bodyRule });
    },
    testTextEditAgent: async options => {
      const c = context(options);
      if (!checkContext(c)) return { status: 'failed', reason: '当前角色已变化，请重新打开' };
      const { message } = await source(options), saved = read(options);
      if (!checkContext(c) || !message) return { status: 'skipped', reason: '暂无可处理的回复' };
      if (saved.config?.kind !== 'text_edit' || !saved.config.enabled) return { status: 'skipped', reason: '请先启用并保存此 Agent' };
      return runtime.run({ agentId: options.id, sessionId: c.sessionId, messageId: message.id, selection: options.selection,
        force: true, invocation: 'test', configOverride: saved.config, bodyRuleOverride: saved.bodyRule });
    },
    runConfiguredFormatReview: async options => {
      if (!checkContext(context(options))) return { status: 'failed', reason: '当前角色已变化，请重新打开' };
      const c = context(options), { message } = await source(options);
      if (!checkContext(c)) return { status: 'failed', reason: '当前角色已变化，请重新打开' };
      const config = read(options).config;
      if (!allowsAgentInvocation(config, 'manual')) return { status: 'skipped', reason: '此 Agent 尚未允许手动调用' };
      return message ? runFormat({ sessionId: c.sessionId, messageId: message.id, signal: options.signal, configOverride: config }) : { status: 'failed', reason: '暂无可处理的回复' };
    },
    getAgentFormatGuide: () => {
      const c = getContext(), config = store.read('reply_check', c).config;
      return { ...c, guide: config.formatGuide, usable: Boolean(config.formatGuide.trim()), stale: false, revision: config.updatedAt };
    },
    setAgentFormatGuide: async options => {
      const c = getContext(), saved = store.read('reply_check', c);
      if (c.sessionId !== options.sessionId || c.scopeId !== options.scopeId) return { ok: false, message: '会话已切换，请重新打开格式要求' };
      if (Number(options.revision || 0) !== saved.config.updatedAt) return { ok: false, message: '格式要求已更新，请重新打开后编辑' };
      const result = await store.save({ ...saved, config: { ...saved.config, formatGuide: String(options.guide || '') } });
      return result.ok ? { ok: true, ...actions.getAgentFormatGuide() } : result;
    },
    openTextEditRun: id => runtime.open(id), cancelTextEditRun: id => runtime.cancel(id), ignoreTextEditRun: id => runtime.ignore(id),
  };
  return actions;
};
