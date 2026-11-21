import { t } from '../i18n/index.js';
import { isReasoningStreamEvent } from '../api/native-reasoning.js';
import { buildReasoningRequestOptions, getReasoningSamplerPolicy } from '../api/model-capabilities.js';
import { applyPresetRequestBody, makeToolPackets } from './preset-request-transport.js';
import { fingerprintScriptCode } from '../storage/script-model-consent-store.js';

// 酒馆 /api/backends/chat-completions/generate（脚本单独调用，不是主生成）：
// 用当前会话的连线档发出；请求体里的 Key、地址、反代、自订网址一律不用。
// 每个脚本第一次调用先请用户同意费用（代码改了再问）；回应照酒馆：非流式回 OpenAI chat.completion，
// 流式回 SSE（data: 分块＋data: [DONE]），错误回 { error: { message } }。

export const TAVERN_GENERATE_PATH = '/api/backends/chat-completions/generate';

const MESSAGES = Object.freeze({
  networkDenied: '脚本没有「访问网络」权限，所以没有调用模型：请在「通用设置 → 角色卡脚本 → 脚本选项」打开「允许脚本访问网络」后重试。',
  missingMessages: '请求缺少 messages，APP 没有调用模型。',
  unknownScript: 'APP 认不出是哪个脚本发出的请求，所以没有调用模型：单独调用模型要先由用户同意发出请求的脚本。',
  consentDenied: '用户没有同意这个脚本单独调用模型（每次调用都会产生费用），这次没有发出请求。这次 APP 运行期间不再询问；重开 APP 后，脚本再次调用时会重新询问。',
  consentDismissed: '费用确认窗在用户作出选择前就关闭了（可能被别的确认窗取代），这次没有调用模型。脚本下次调用时会再询问。',
  noConnection: '当前会话没有可用的 API 连线，所以没有调用模型：请到 APP 的 API 设置确认这条连线后重试。',
  upstreamFailed: '模型请求没有成功：请到 APP 的 API 设置确认当前会话的连线能正常使用。',
  upstreamFailedStatus: '模型请求没有成功（上游回应 HTTP {status}）：请到 APP 的 API 设置确认当前会话的连线能正常使用。',
  cancelled: '请求已取消。',
});

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const trim = value => String(value ?? '').trim();
const fail = (status, message) => ({ status, body: { error: { message } } });
const finiteNumber = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const providerFamily = provider => (['gemini', 'makersuite', 'vertexai'].includes(provider)
  ? 'gemini' : provider === 'anthropic' ? 'anthropic' : 'openai');

// 只取请求体里的生成参数，换成主程式模型客户端的选项名；工具照主生成预设请求同一套换算
// reasoning：这个会话的思考设定 { requestReasoning, reasoningEffort }（同主生成，会话／模式覆盖优先、否则用预设）。
// 要不要思考跟会话；开着时强度优先用脚本请求体的 reasoning_effort。没给 reasoning（预设关着）时不送思考参数，同主生成。
export const buildTavernGenerateOptions = (body = {}, config = {}, reasoning = null) => {
  const source = isPlainObject(body) ? body : {};
  const family = providerFamily(trim(config?.provider).toLowerCase());
  const options = {};
  if (finiteNumber(source.temperature) !== undefined) options.temperature = source.temperature;
  if (finiteNumber(source.top_p) !== undefined) options.top_p = source.top_p;
  const maxTokens = Math.trunc(finiteNumber(source.max_tokens) ?? finiteNumber(source.max_completion_tokens) ?? 0);
  if (maxTokens > 0) options[family === 'openai' ? 'max_tokens' : 'maxTokens'] = maxTokens;
  const stop = (Array.isArray(source.stop) ? source.stop : [source.stop]).filter(item => typeof item === 'string' && item);
  if (stop.length && family === 'openai') options.stop = stop;
  if (stop.length && family === 'anthropic') options.stop_sequences = stop;
  const tools = Array.isArray(source.tools) ? source.tools.filter(isPlainObject) : [];
  if (tools.length) {
    Object.assign(options, applyPresetRequestBody({
      messages: [],
      tools,
      ...(source.tool_choice !== undefined ? { tool_choice: source.tool_choice } : {}),
    }, {}, config).options);
  }
  if (isPlainObject(reasoning)) {
    const requestReasoning = reasoning.requestReasoning === true;
    const target = { provider: config?.provider, model: config?.model, baseUrl: config?.baseUrl, requestReasoning };
    getReasoningSamplerPolicy(target).disabledFields.forEach((field) => { delete options[field]; });
    Object.assign(options, buildReasoningRequestOptions({
      ...target,
      reasoningEffort: trim(source.reasoning_effort) || reasoning.reasoningEffort,
      maxOutputTokens: maxTokens > 0 ? maxTokens : undefined,
    }));
  }
  return options;
};

const FINISH_REASONS = Object.freeze({
  stop: 'stop', end_turn: 'stop', stop_sequence: 'stop',
  length: 'length', max_tokens: 'length',
  tool_calls: 'tool_calls', tool_use: 'tool_calls',
  content_filter: 'content_filter', safety: 'content_filter',
});
export const toTavernFinishReason = (reason = '', hasToolCalls = false) => (hasToolCalls
  ? 'tool_calls'
  : FINISH_REASONS[trim(reason).toLowerCase()] || 'stop');

// 主程式量到的用量（provider-usage 的格式）换回 OpenAI 的 usage；没量到的栏位不写
export const buildTavernUsage = (usage = null) => {
  if (!isPlainObject(usage)) return null;
  const count = value => (Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null);
  const prompt = count(usage.promptTokens);
  const completion = count(usage.completionTokens);
  const total = count(usage.totalTokens) ?? (prompt !== null && completion !== null ? prompt + completion : null);
  const output = {
    ...(prompt !== null ? { prompt_tokens: prompt } : {}),
    ...(completion !== null ? { completion_tokens: completion } : {}),
    ...(total !== null ? { total_tokens: total } : {}),
  };
  return Object.keys(output).length ? output : null;
};

export const buildTavernChatCompletion = ({ id = '', created = 0, model = '', content = '', toolCalls = [], usage = null } = {}) => {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const usageBody = buildTavernUsage(usage);
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: String(content ?? ''), ...(calls.length ? { tool_calls: calls } : {}) },
      finish_reason: toTavernFinishReason(usage?.finishReason, calls.length > 0),
    }],
    ...(usageBody ? { usage: usageBody } : {}),
  };
};

// 回给脚本的错误只说明 HTTP 状态，不带上游原文（可能含地址或 Key）
const upstreamStatus = (error) => {
  const status = Math.trunc(Number(error?.status || error?.statusCode || 0));
  return status >= 400 && status <= 599 ? status : 0;
};
const upstreamErrorMessage = (error) => {
  const status = upstreamStatus(error);
  return status ? MESSAGES.upstreamFailedStatus.replace('{status}', String(status)) : MESSAGES.upstreamFailed;
};

export const buildScriptModelConsentDialog = ({ scriptName = '', scope = 'global', sourceName = '', profileName = '', model = '' } = {}) => {
  const source = scope === 'character'
    ? t('角色卡「{name}」', { name: sourceName || '-' })
    : scope === 'preset'
      ? t('预设「{name}」', { name: sourceName || '-' })
      : t('全局脚本');
  // appChoice 的选项：按「拒绝」回 deny、按「同意」回 approve；关掉或被别的确认窗取代回 null
  return {
    title: t('脚本要单独调用模型'),
    message: [
      t('「{script}」（来自{source}）要用当前会话的连线「{profile}」调用模型 {model}。', {
        script: scriptName || '-', source, profile: profileName || '-', model: model || '-',
      }),
      t('每次调用都会产生费用。'),
      t('同意后，这个脚本之后调用模型不再询问；脚本代码更新后会再询问一次。'),
    ].join('\n\n'),
    actions: [
      { id: 'deny', label: t('拒绝') },
      { id: 'approve', label: t('同意'), primary: true },
    ],
  };
};

export const createTavernGenerateHandler = ({
  // ({ sessionId }) => { config, client, createClient(model), normalizeMessages?, requestContext?, cacheKey, profileName }
  resolveConnection,
  // ({ scriptId, sessionId }) => { id, name, content, scope, scopeId, sourceName } | null
  findScript,
  consentStore,
  // (dialogOptions) => 'approve' | 'deny' | null（null：确认窗关掉或被取代，没有作出选择）
  confirm,
  // 执行流记录：{ start(info) => handle, finish(handle, result), record(info, result) }
  runTracker = null,
  postStream = () => {},
  log = () => {},
  fingerprint = fingerprintScriptCode,
  now = () => Date.now(),
  modelListTtlMs = 5 * 60 * 1000,
  modelListFailureTtlMs = 60 * 1000,
} = {}) => {
  const active = new Map();
  // 这次运行内拒绝过的脚本（同一份代码）不再弹窗；同一脚本同时多个请求只弹一次；不同脚本的确认窗排队
  const denied = new Set();
  const asking = new Map();
  let confirmQueue = Promise.resolve();
  const modelLists = new Map();
  const notes = new Set();
  let seq = 0;

  const cancelled = () => fail(499, MESSAGES.cancelled);
  const nextId = () => `chatcmpl-app-${now().toString(36)}-${(++seq).toString(36)}`;

  const describeScript = async (request, sessionId) => {
    const scriptId = trim(request?.scriptId);
    const record = scriptId ? findScript({ scriptId, sessionId }) : null;
    if (!record || !trim(record.id)) return null;
    return {
      id: trim(record.id),
      name: trim(record.name) || trim(request?.scriptName) || trim(record.id),
      scope: record.scope,
      scopeId: trim(record.scopeId),
      sourceName: trim(record.sourceName),
      fingerprint: await fingerprint(String(record.content ?? '')),
    };
  };

  // 连线的模型清单在本次运行内缓存一小段时间，不每次都打 /models
  const listModels = (connection) => {
    const key = String(connection.cacheKey || '');
    const cached = modelLists.get(key);
    if (cached && cached.expiresAt > now()) return cached.promise;
    const entry = { expiresAt: now() + modelListTtlMs, promise: null };
    entry.promise = Promise.resolve()
      .then(() => connection.client.listModels())
      .then(
        list => new Set((Array.isArray(list) ? list : []).map(item => trim(isPlainObject(item) ? item.id : item)).filter(Boolean)),
        () => { entry.expiresAt = now() + modelListFailureTtlMs; return null; },
      );
    modelLists.set(key, entry);
    return entry.promise;
  };
  const note = (script, reason, requested, model) => {
    const key = [script.id, reason, requested, model].join('\u0000');
    if (notes.has(key)) return;
    notes.add(key);
    const params = { script: script.name, requested, model: model || '-' };
    log(reason === 'unspecified'
      ? { type: 'info', message: t('脚本「{script}」没有指定模型，用当前会话连线的模型 {model}', params) }
      : reason === 'unavailable'
        ? { type: 'warn', message: t('脚本「{script}」指定的模型 {requested} 不在当前会话连线的模型清单里，这次改用连线的模型 {model}', params) }
        : { type: 'warn', message: t('读不到当前会话连线的模型清单，无法确认脚本「{script}」指定的模型 {requested}，这次改用连线的模型 {model}', params) });
  };
  // 脚本指定的模型在连线的清单里就照用；没指定或不在清单里用连线档本身的模型
  const chooseModel = async (connection, body, script) => {
    const current = trim(connection.config?.model);
    const requested = typeof body.model === 'string' ? trim(body.model) : '';
    if (requested && requested === current) return { model: current, client: connection.client, requested };
    if (!requested) {
      note(script, 'unspecified', '', current);
      return { model: current, client: connection.client, requested, reason: 'unspecified' };
    }
    const available = await listModels(connection);
    if (available?.has(requested)) return { model: requested, client: connection.createClient(requested), requested };
    const reason = available ? 'unavailable' : 'unverified';
    note(script, reason, requested, current);
    return { model: current, client: connection.client, requested, reason };
  };

  // 回 granted（已同意或这次同意）、denied（这次按了拒绝）、denied_before（这次运行拒绝过，不再弹窗）、
  // dismissed（确认窗没作出选择就关了，例如被别的确认窗取代：不记拒绝，下次再问）
  const ensureConsent = (script, { profileName, model }) => {
    const key = `${script.id}\u0000${script.fingerprint}`;
    if (denied.has(key)) return Promise.resolve('denied_before');
    if (asking.has(key)) return asking.get(key);
    const run = (async () => {
      if (await consentStore.isGranted(script.id, script.fingerprint)) return 'granted';
      const answer = confirmQueue.then(() => confirm(buildScriptModelConsentDialog({
        scriptName: script.name, scope: script.scope, sourceName: script.sourceName, profileName, model,
      })));
      confirmQueue = answer.catch(() => null);
      let choice = null;
      try { choice = await answer; } catch { return 'dismissed'; }
      if (choice === 'deny') {
        denied.add(key);
        return 'denied';
      }
      if (choice !== 'approve') return 'dismissed';
      try {
        await consentStore.grant({
          scriptId: script.id, scriptName: script.name, scope: script.scope, scopeId: script.scopeId,
          sourceName: script.sourceName, fingerprint: script.fingerprint,
        });
      } catch {
        log({ type: 'warn', message: t('脚本「{script}」调用模型的同意没能存档，重开 APP 后会再询问', { script: script.name }) });
      }
      return 'granted';
    })().finally(() => asking.delete(key));
    asking.set(key, run);
    return run;
  };

  const logUsage = (script, model, usage) => {
    const body = buildTavernUsage(usage);
    log(body
      ? { type: 'info', message: t('脚本「{script}」单独调用模型 {model}：输入 {input} tokens，输出 {output} tokens', {
        script: script.name, model: model || '-', input: body.prompt_tokens ?? '?', output: body.completion_tokens ?? '?',
      }) }
      : { type: 'info', message: t('脚本「{script}」单独调用模型 {model}，连线没有回报用量', { script: script.name, model: model || '-' }) });
  };
  const logFailure = (script, model, error) => {
    const status = upstreamStatus(error);
    log({ type: 'warn', message: t('脚本「{script}」单独调用模型 {model} 没有成功（{reason}）', {
      script: script.name, model: model || '-', reason: status ? `HTTP ${status}` : trim(error?.name) || 'Error',
    }) });
  };

  // 执行流记录出错不影响请求
  const track = (method, ...args) => {
    try { return runTracker?.[method]?.(...args) ?? null; } catch { return null; }
  };

  const runOnce = async ({ client, model, messages, options, signal, script, config, run }) => {
    const tools = makeToolPackets(config, () => {});
    let usage = null;
    let toolError = null;
    try {
      const content = await client.chat(messages, {
        ...options,
        signal,
        onProviderUsage: (value) => { usage = value; },
        onProviderToolCallDelta: (raw, meta) => { try { tools.push(raw, meta); } catch (error) { toolError = error; } },
      });
      if (toolError) throw toolError;
      logUsage(script, model, usage);
      track('finish', run, { status: 'succeeded', usage });
      return {
        status: 200,
        body: buildTavernChatCompletion({
          id: nextId(), created: Math.floor(now() / 1000), model, content, toolCalls: tools.complete(), usage,
        }),
      };
    } catch (error) {
      if (signal.aborted && !toolError) {
        track('finish', run, { status: 'cancelled', cancelReason: 'script_aborted', usage });
        return cancelled();
      }
      logFailure(script, model, toolError || error);
      track('finish', run, { status: 'failed', errorMessage: upstreamErrorMessage(toolError || error), usage });
      return fail(502, upstreamErrorMessage(toolError || error));
    }
  };

  // 有第一段输出才回 200＋SSE；在那之前失败的照非流式回 JSON 错误。之后的分块经 tavern_stream 送进 Worker
  const startStream = ({ requestId, client, model, messages, options, controller, script, config, run }) => new Promise((resolveStart) => {
    const { signal } = controller;
    const id = nextId();
    const created = Math.floor(now() / 1000);
    const post = data => postStream({ type: 'tavern_stream', id: requestId, event: 'data', data });
    const chunk = (delta, finishReason = null, extra = {}) => `data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra,
    })}\n\n`;
    let started = false;
    let roleSent = false;
    const begin = () => {
      if (started) return;
      started = true;
      resolveStart({ status: 200, stream: true });
    };
    const emitDelta = (delta) => {
      const value = roleSent ? delta : { role: 'assistant', ...delta };
      roleSent = true;
      begin();
      post(chunk(value));
    };
    void (async () => {
      let usage = null;
      let toolError = null;
      let succeeded = false;
      let outcome = { status: 'failed' };
      const tools = makeToolPackets(config, call => emitDelta({ tool_calls: [call] }));
      try {
        const stream = client.streamChat(messages, {
          ...options,
          signal,
          onProviderUsage: (value) => { usage = value; },
          onProviderToolCallDelta: (raw, meta) => {
            try { tools.push(raw, meta); } catch (error) { toolError = error; controller.abort(); }
          },
        });
        for await (const value of stream) {
          if (toolError) break;
          if (typeof value === 'string') {
            if (value) emitDelta({ content: value });
          } else if (isReasoningStreamEvent(value) && value.text) {
            emitDelta({ reasoning_content: String(value.text) });
          }
        }
        if (toolError) throw toolError;
        begin();
        post(chunk(roleSent ? {} : { role: 'assistant', content: '' }, toTavernFinishReason(usage?.finishReason, tools.complete().length > 0)));
        const usageBody = buildTavernUsage(usage);
        if (usageBody) post(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageBody })}\n\n`);
        post('data: [DONE]\n\n');
        succeeded = true;
        outcome = { status: 'succeeded' };
      } catch (error) {
        const aborted = signal.aborted && !toolError;
        const message = upstreamErrorMessage(toolError || error);
        if (!started) resolveStart(aborted ? cancelled() : fail(502, message));
        else if (!aborted) post(`data: ${JSON.stringify({ error: { message } })}\n\n`);
        if (!aborted) logFailure(script, model, toolError || error);
        outcome = aborted ? { status: 'cancelled', cancelReason: 'script_aborted' } : { status: 'failed', errorMessage: message };
      } finally {
        active.delete(requestId);
        if (started) postStream({ type: 'tavern_stream', id: requestId, event: 'end' });
        if (succeeded || usage) logUsage(script, model, usage);
        track('finish', run, { ...outcome, usage });
      }
    })();
  });

  const handle = async (request = {}, access = {}) => {
    const requestId = trim(request?.requestId) || nextId();
    const controller = new AbortController();
    active.set(requestId, controller);
    let streaming = false;
    try {
      if (access.allowNetwork !== true) return fail(403, MESSAGES.networkDenied);
      const body = isPlainObject(request?.body) ? request.body : {};
      const messages = Array.isArray(body.messages) ? body.messages.filter(isPlainObject) : [];
      if (!messages.length) return fail(400, MESSAGES.missingMessages);
      const sessionId = trim(access.sessionId);
      const script = await describeScript(request, sessionId);
      if (!script) return fail(403, MESSAGES.unknownScript);
      let connection = null;
      try { connection = await resolveConnection({ sessionId }); } catch {}
      if (!connection?.client || !connection?.config) return fail(502, MESSAGES.noConnection);
      const { model, client, requested, reason } = await chooseModel(connection, body, script);
      if (controller.signal.aborted) return cancelled();
      const profileName = trim(connection.profileName) || trim(connection.config.provider);
      const runInfo = {
        sessionId, scriptId: script.id, scriptName: script.name, scope: script.scope, sourceName: script.sourceName,
        model, requestedModel: requested, modelNote: reason || '', provider: trim(connection.config.provider), stream: body.stream === true,
      };
      // 等用户同意时不建运行记录；用户作出选择（或等待中被取消）后照实际结果记
      const consent = await ensureConsent(script, { profileName, model });
      if (consent === 'denied') {
        track('record', runInfo, { status: 'cancelled', cancelReason: 'consent_denied', reason: 'consent denied' });
        return fail(403, MESSAGES.consentDenied);
      }
      if (consent === 'denied_before') return fail(403, MESSAGES.consentDenied);
      if (consent === 'dismissed') {
        track('record', runInfo, { status: 'cancelled', cancelReason: 'consent_dismissed', reason: 'consent dialog closed' });
        return fail(403, MESSAGES.consentDismissed);
      }
      if (controller.signal.aborted) {
        track('record', runInfo, { status: 'cancelled', cancelReason: 'script_aborted', reason: 'cancelled before sending' });
        return cancelled();
      }
      const config = { ...connection.config, model };
      const cloned = JSON.parse(JSON.stringify(messages));
      const prepared = {
        requestId,
        client,
        model,
        messages: typeof connection.normalizeMessages === 'function' ? connection.normalizeMessages(cloned) : cloned,
        options: {
          ...buildTavernGenerateOptions(body, config, connection.reasoning || null),
          ...(connection.requestContext ? { requestContext: connection.requestContext } : {}),
        },
        controller,
        signal: controller.signal,
        script,
        config,
      };
      prepared.run = track('start', runInfo);
      if (body.stream === true) {
        streaming = true;
        return await startStream(prepared);
      }
      return await runOnce(prepared);
    } finally {
      if (!streaming) active.delete(requestId);
    }
  };

  // 脚本取消（AbortSignal 或读流时 cancel）：中止上游请求
  const cancel = (requestId) => {
    const controller = active.get(trim(requestId));
    if (!controller) return false;
    controller.abort();
    return true;
  };
  const cancelAll = () => {
    for (const controller of active.values()) controller.abort();
  };

  return { handle, cancel, cancelAll };
};
