import { renderRequestParamReport, requestParamStatusLabel } from '../request-param-report-view.js';
import {
  formatDateTime as formatLocalizedDateTime,
  formatNumber,
  translateUiText,
} from '../../i18n/index.js';

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const truncateBase64 = (value) => {
  if (typeof value !== 'string') return value;
  return value.replace(/data:[^;]+;base64,[A-Za-z0-9+/=]{100,}/g, (match) => {
    const commaAt = match.indexOf(',');
    if (commaAt < 0) return match;
    return `${match.slice(0, commaAt + 1)}...(${match.length - commaAt - 1} chars)`;
  });
};

const stringifyContent = (content) => {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return truncateBase64(content);
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text') return String(part.text || '');
      if (part.type === 'image_url') {
        const url = String(part.image_url?.url || '');
        return url.startsWith('data:') ? '[图片：base64]' : `[图片：${url}]`;
      }
      if (part.type === 'input_audio') return '[语音]';
      try { return JSON.stringify(part, null, 2); } catch { return '[复合内容]'; }
    }).filter(Boolean).join('\n');
  }
  try { return truncateBase64(JSON.stringify(content, null, 2)); } catch { return String(content); }
};

const stringifyMessage = (message) => {
  const blocks = [];
  const content = stringifyContent(message?.content);
  if (String(content || '').length) blocks.push(String(content));
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length) {
    try { blocks.push(JSON.stringify({ tool_calls: message.tool_calls }, null, 2)); } catch {}
  }
  if (message?.tool_call_id) blocks.push(`tool_call_id: ${String(message.tool_call_id)}`);
  return blocks.join('\n');
};

const toFiniteNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
};

const formatInt = (value) => {
  const next = toFiniteNumber(value);
  return next === null ? '—' : formatNumber(Math.max(0, Math.trunc(next)));
};

const formatDuration = (value) => {
  const next = toFiniteNumber(value);
  if (next === null || next < 0) return '—';
  if (next < 1000) return `${Math.round(next)} ms`;
  return `${(next / 1000).toFixed(next < 10_000 ? 2 : 1)} s`;
};

const normalizeParamEntries = (request) => {
  const merged = request?.wireRequest?.body || { ...(request?.options || {}), ...(request?.requestOptions || {}) };
  const skipped = new Set([
    'input', 'model', 'stream', 'messages', 'contents', 'system', 'systemInstruction', 'requestParamConstraints',
    'signal',
    'requestContext',
    'nativeRequestId',
    'tools',
    'tool_choice',
    'onProviderUsage',
    'onProviderToolCallDelta',
  ]);
  return Object.entries(merged)
    .filter(([key, value]) => !skipped.has(key) && value !== undefined && typeof value !== 'function')
    .map(([key, value]) => {
      if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return { key, value: value === null ? 'null' : String(value), kind: typeof value };
      }
      if (Array.isArray(value)) return { key, value: `${value.length} 项`, kind: 'summary' };
      if (typeof value === 'object') return { key, value: `${Object.keys(value).length} 个字段`, kind: 'summary' };
      return { key, value: String(value), kind: 'summary' };
    });
};

const renderParamValue = (entry) => {
  if (entry.kind === 'string') return `<span class="prompt-json-string">&quot;${escapeHtml(entry.value)}&quot;</span>`;
  if (entry.kind === 'number') return `<span class="prompt-json-number">${escapeHtml(entry.value)}</span>`;
  if (entry.kind === 'boolean') return `<span class="prompt-json-boolean">${escapeHtml(entry.value)}</span>`;
  if (entry.kind === 'object') return '<span class="prompt-json-muted">null</span>';
  return `<span class="prompt-json-summary">${escapeHtml(entry.value)}</span>`;
};

const roleCounts = (messages) => {
  const counts = new Map();
  messages.forEach((message) => {
    const role = String(message?.role || 'message').trim().toLowerCase() || 'message';
    counts.set(role, (counts.get(role) || 0) + 1);
  });
  return Array.from(counts.entries());
};

const renderMetricCard = ({ label, value, note = '', state = '' }) => `
  <article class="prompt-overview-metric${state ? ` is-${state}` : ''}">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(value)}</strong>
    ${note ? `<small>${escapeHtml(note)}</small>` : ''}
  </article>
`;

export const buildPromptOverviewView = (request = null, {
  injectionAuditHtml = '',
  injectionAuditText = '',
} = {}) => {
  const req = request && typeof request === 'object' ? request : {};
  const messages = Array.isArray(req.messages) ? req.messages : [];
  const roles = roleCounts(messages);
  const audit = req.injectionAudit && typeof req.injectionAudit === 'object' ? req.injectionAudit : {};
  const globalPromptAudit = audit.globalPrompt && typeof audit.globalPrompt === 'object'
    ? audit.globalPrompt
    : {};
  const globalPromptBlocks = Array.isArray(globalPromptAudit.injected) ? globalPromptAudit.injected : [];
  const globalPromptSkipped = Array.isArray(globalPromptAudit.skipped) ? globalPromptAudit.skipped : [];
  const diagnostics = req.responseDiagnostics && typeof req.responseDiagnostics === 'object'
    ? req.responseDiagnostics
    : {};
  const webSearch = req.webSearch && typeof req.webSearch === 'object' ? req.webSearch : {};
  const webSearchStatus = req.webSearchStatus && typeof req.webSearchStatus === 'object'
    ? req.webSearchStatus
    : {};
  const webSearchEnabled = webSearch.enabled === true;
  const webSearchRoute = String(webSearch.route || '').trim();
  const webSearchExecution = String(
    webSearchStatus.execution
    || webSearch.execution
    || (webSearchRoute.endsWith('_native') ? 'provider_native' : 'app_tool'),
  ).trim();
  const webSearchObservedState = String(webSearchStatus.state || '').trim()
    || (webSearchEnabled ? 'ready_not_observed' : 'disabled');
  const webSearchEngine = String(
    webSearchStatus.engine || diagnostics.webSearchEngine || webSearch.searchEngine || '',
  ).trim();
  const params = normalizeParamEntries(req);
  const transport = req.phoneReplyTransport && typeof req.phoneReplyTransport === 'object'
    ? req.phoneReplyTransport
    : {};
  const transportMode = String(transport.effectiveMode || transport.requestedMode || '').trim();
  const transportLabels = {
    provider_fc: '原生 FC',
    json_terminal: 'JSON 终态',
    legacy_text: '传统文本',
    fc_fallback: 'FC 失败后文本回退',
    json_fallback: 'JSON 失败后文本回退',
  };
  const transportLabel = transportLabels[transportMode] || transportMode;
  const routeLayer = String(transport.routeLayer || '').trim();
  const routeLayerLabels = {
    verified_native_fc: '原生 FC',
    local_observed_compatible: '本机观察兼容',
    fc_probation: 'FC 试用',
    json_terminal: 'JSON 终态',
    json_after_fc_circuit: 'JSON 终态 · FC 熔断后降级',
    legacy_text: '传统文本',
  };
  const routeLayerLabel = ['fc_fallback', 'json_fallback'].includes(transportMode)
    ? transportLabel
    : (routeLayerLabels[routeLayer] || transportLabel || '传统文本');
  const routePreviewState = String(transport.previewState || '').trim() === 'predicted'
    ? 'predicted'
    : 'actual';
  const routeStateLabel = routePreviewState === 'predicted' ? '候选路由（预测）' : '实际路由';
  const transportReason = String(
    transport.fallbackReason
    || transport.routeReason
    || transport.eligibilityReason
    || transport.providerRolloutReason
    || '',
  ).trim();
  const snapshotFingerprint = String(transport.snapshotFingerprint || '').trim();
  const hasTransportThinking = Object.prototype.hasOwnProperty.call(transport, 'thinkingRequested')
    || Object.prototype.hasOwnProperty.call(transport, 'thinkingEnabled')
    || Boolean(String(transport.thinkingOverrideReason || '').trim());
  const transportThinkingOverrideReason = String(transport.thinkingOverrideReason || '').trim();
  const terminalToolSchema = transport.terminalToolSchema
    && typeof transport.terminalToolSchema === 'object'
    ? transport.terminalToolSchema
    : null;
  const terminalToolSchemaJson = terminalToolSchema
    ? JSON.stringify(terminalToolSchema, null, 2)
    : '';
  const jsonContract = transport.jsonContract && typeof transport.jsonContract === 'object'
    ? transport.jsonContract
    : null;
  const jsonContractJson = jsonContract ? JSON.stringify(jsonContract.schema || {}, null, 2) : '';
  const schemaEstimateTokens = toFiniteNumber(transport.schemaEstimateTokens);
  const semanticMessageEstimateTokens = toFiniteNumber(transport.semanticMessageEstimateTokens);
  const contractInstructionEstimateTokens = toFiniteNumber(transport.contractInstructionEstimateTokens);
  const contractSummary = transport.contractSummary && typeof transport.contractSummary === 'object'
    ? transport.contractSummary
    : null;
  const contractTarget = String(contractSummary?.frozenTarget?.targetName || '').trim();
  const summarizeTargets = value => (Array.isArray(value) ? value : [])
    .map(item => String(item?.name || item?.id || '').trim())
    .filter(Boolean)
    .join('、');
  const contractMembers = summarizeTargets(contractSummary?.frozenTarget?.members);
  const contractMomentAuthors = summarizeTargets(contractSummary?.frozenTarget?.momentAuthors);
  const contractPrivateTargets = summarizeTargets(contractSummary?.frozenTarget?.privateTargets);
  const contractGroupTargets = summarizeTargets(contractSummary?.frozenTarget?.groupTargets);
  const contractItemTypes = Array.isArray(contractSummary?.allowedItemTypes)
    ? contractSummary.allowedItemTypes.map(String).filter(Boolean)
    : [];
  const contractStickers = Array.isArray(contractSummary?.allowedStickerKeywords)
    ? contractSummary.allowedStickerKeywords.map(String).filter(Boolean)
    : [];
  const contractTables = Array.isArray(contractSummary?.tableTargets)
    ? contractSummary.tableTargets.filter(item => item && typeof item === 'object')
    : [];
  const contractOrder = Array.isArray(contractSummary?.fixedOrder)
    ? contractSummary.fixedOrder.map(String).filter(Boolean)
    : [];
  const contractSummaryRows = [
    contractTarget ? ['冻结目标', contractTarget, true] : null,
    contractMembers ? ['冻结群成员', contractMembers, true] : null,
    contractMomentAuthors ? ['动态作者候选', contractMomentAuthors, true] : null,
    contractPrivateTargets ? ['可选私聊目标', contractPrivateTargets, true] : null,
    contractGroupTargets ? ['可选群聊目标', contractGroupTargets, true] : null,
    contractItemTypes.length ? ['允许消息类型', contractItemTypes.join('、')] : null,
    contractStickers.length ? ['贴图白名单', contractStickers.join('、'), true] : null,
    contractTables.length
      ? ['可写表与行', contractTables.map(table => (
          `${String(table.name || table.id || '未命名表')}（${Array.isArray(table.rowIds) ? table.rowIds.length : 0} 行）`
        )).join('、'), false, contractTables.map(table => (
          `<span data-i18n-skip>${escapeHtml(String(table.name || table.id || '未命名表'))}</span><span>（${Array.isArray(table.rowIds) ? table.rowIds.length : 0} 行）</span>`
        )).join('、')]
      : null,
    contractOrder.length ? ['固定顺序', contractOrder.join(' → ')] : null,
  ].filter(Boolean);
  const tokenAttributionAvailable = [
    semanticMessageEstimateTokens,
    contractInstructionEstimateTokens,
    schemaEstimateTokens,
  ].some(value => value !== null);
  const mergedRequestOptions = { ...(req.options || {}), ...(req.requestOptions || {}) };
  const toolChoice = mergedRequestOptions.tool_choice ?? mergedRequestOptions.toolChoice;
  const geminiFunctionCalling = mergedRequestOptions.toolConfig?.functionCallingConfig;
  const toolChoiceLabel = (typeof toolChoice === 'string'
    ? toolChoice
    : String(toolChoice?.function?.name || toolChoice?.name || toolChoice?.type || '').trim())
    || (geminiFunctionCalling
      ? [
          String(geminiFunctionCalling.mode || '').trim(),
          ...(Array.isArray(geminiFunctionCalling.allowedFunctionNames)
            ? geminiFunctionCalling.allowedFunctionNames.map(String).filter(Boolean)
            : []),
        ].filter(Boolean).join(' · ')
      : '');
  const responseFormat = mergedRequestOptions.response_format ?? mergedRequestOptions.responseFormat;
  const responseFormatLabel = typeof responseFormat === 'string'
    ? responseFormat
    : String(responseFormat?.type || '').trim();
  const reasoningEffort = String(
    mergedRequestOptions.reasoning?.effort || mergedRequestOptions.reasoning_effort || '',
  ).trim();
  const parallelToolCalls = typeof mergedRequestOptions.parallel_tool_calls === 'boolean'
    ? mergedRequestOptions.parallel_tool_calls
    : (toolChoice?.disable_parallel_tool_use === true ? false : null);
  const routeOptionFacts = [
    toolChoiceLabel ? `tool_choice · ${toolChoiceLabel}` : '',
    typeof parallelToolCalls === 'boolean'
      ? `parallel_tool_calls · ${parallelToolCalls}`
      : '',
    reasoningEffort ? `reasoning.effort · ${reasoningEffort}` : '',
    responseFormatLabel ? `response_format · ${responseFormatLabel}` : '',
    String(mergedRequestOptions.thinking?.type || '').trim()
      ? `thinking · ${String(mergedRequestOptions.thinking.type).trim()}`
      : '',
  ].filter(Boolean);
  const routeWarning = Boolean(
    transportMode === 'fc_fallback'
    || transportMode === 'json_fallback'
    || transport.circuitOpen === true
    || Number(transport.cooldownUntil || 0) > Date.now()
    || transportThinkingOverrideReason
    || String(transport.routeReason || '').trim()
    || String(transport.fallbackReason || '').trim()
  );
  const at = req.at
    ? formatLocalizedDateTime(req.at, {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
    : '—';
  const estimatedInput = toFiniteNumber(audit.totalEstimateTokens ?? audit.usedTokens);
  const inputBudget = toFiniteNumber(audit.inputBudgetTokens);
  const headroom = Number.isFinite(estimatedInput) && Number.isFinite(inputBudget)
    ? Math.max(0, inputBudget - estimatedInput)
    : null;
  const usagePercent = Number.isFinite(estimatedInput) && Number.isFinite(inputBudget) && inputBudget > 0
    ? Math.max(0, Math.min(100, (estimatedInput / inputBudget) * 100))
    : null;
  const firstTokenLatencyMs = toFiniteNumber(
    diagnostics.firstMeaningfulDeltaLatencyMs ?? diagnostics.firstTokenLatencyMs,
  );
  const tokensPerSecond = toFiniteNumber(diagnostics.tokensPerSecond);
  const firstTokenValue = firstTokenLatencyMs !== null
    ? formatDuration(firstTokenLatencyMs)
    : (req.stream ? '未记录' : '非流式');
  const tpsValue = tokensPerSecond !== null
    ? `${tokensPerSecond.toFixed(1)} tok/s`
    : '—';
  const fingerprint = String(diagnostics.systemFingerprint || '').trim();
  const providerUnavailable = translateUiText('供应方未返回');
  const responseIdentities = [
    ['system fingerprint', fingerprint],
    ['model version', diagnostics.modelVersion],
    ['response id', diagnostics.responseId],
    ['response model', diagnostics.responseModel],
    ['routed provider', diagnostics.routedProvider],
  ].map(([label, value]) => [label, String(value || '').trim()]).filter(([, value]) => value);
  const providerCalls = (Array.isArray(diagnostics.providerCalls) ? diagnostics.providerCalls : [])
    .slice(0, 12)
    .map(call => ({
      callIndex: Math.max(0, Math.trunc(Number(call?.callIndex) || 0)),
      mode: String(call?.mode || ''),
      outcome: String(call?.outcome || ''),
      provider: String(call?.provider || ''),
      model: String(call?.model || ''),
      stream: call?.stream === true,
      latencyMs: toFiniteNumber(call?.latencyMs),
      firstMeaningfulDeltaLatencyMs: toFiniteNumber(call?.firstMeaningfulDeltaLatencyMs),
      outputDurationMs: toFiniteNumber(call?.outputDurationMs),
      tokensPerSecond: toFiniteNumber(call?.tokensPerSecond),
      promptTokens: toFiniteNumber(call?.promptTokens),
      completionTokens: toFiniteNumber(call?.completionTokens),
      totalTokens: toFiniteNumber(call?.totalTokens),
      finishReason: String(call?.finishReason || ''),
      systemFingerprint: String(call?.systemFingerprint || ''),
      modelVersion: String(call?.modelVersion || ''),
      responseId: String(call?.responseId || ''),
      responseModel: String(call?.responseModel || ''),
      routedProvider: String(call?.routedProvider || ''),
      webSearchRequests: toFiniteNumber(call?.webSearchRequests),
      webSearchTokens: toFiniteNumber(call?.webSearchTokens),
      webSearchEngine: String(call?.webSearchEngine || ''),
    }));
  const providerCallsJson = providerCalls.length ? JSON.stringify(providerCalls, null, 2) : '';
  const providerCallTotalTokens = providerCalls.reduce((sum, call) => (
    sum + (Number.isFinite(call.totalTokens) ? call.totalTokens : 0)
  ), 0);
  const requestRows = [
    ['request_id', req.requestId || '—'],
    ['provider', req.provider || '—'],
    ['model', req.model || '—'],
    ['base_url', req.baseUrl || '—'],
    ...(req.apiFormat ? [['api_format', req.apiFormat]] : []),
    ...(req.wireRequest?.url ? [['endpoint', req.wireRequest.url]] : []),
    ['stream', req.stream ? 'true' : 'false'],
    ['session', req.session?.name || req.session?.id || '—'],
    ['profile', req.configProfile?.id || req.configProfile?.source || 'global'],
    ['message_count', String(messages.length)],
    ['response_prefix', req.responsePrefix ? 'present' : 'none'],
    ...(globalPromptBlocks.length ? [['global_prompt_blocks', String(globalPromptBlocks.length)]] : []),
    ...(transportMode ? [['reply_transport', transportMode]] : []),
    ...(transport.previewState ? [['route_state', routePreviewState]] : []),
    ...(routeLayer ? [['route_layer', routeLayer]] : []),
    ...(transportReason ? [['transport_reason', transportReason]] : []),
    ...(snapshotFingerprint ? [['semantic_snapshot', snapshotFingerprint]] : []),
    ...(transport.capabilitySource ? [['capability_source', transport.capabilitySource]] : []),
    ...(hasTransportThinking ? [
      ['fc_thinking_requested', transport.thinkingRequested === true ? 'true' : 'false'],
      ['fc_thinking_enabled', transport.thinkingEnabled === true ? 'true' : 'false'],
    ] : []),
    ...(transportThinkingOverrideReason
      ? [['fc_thinking_override', transportThinkingOverrideReason]]
      : []),
    ...(webSearchRoute ? [['web_search_route', webSearchRoute]] : []),
    ...(webSearchEnabled ? [
      ['web_search_execution', webSearchExecution || 'unknown'],
      ['web_search_state', webSearchObservedState],
    ] : []),
    ...(webSearchEngine ? [['web_search_engine', webSearchEngine]] : []),
  ];

  const requestJsonRows = requestRows.map(([key, value], index) => `
    <div class="prompt-overview-code-line">
      <span class="prompt-overview-line-number">${index + 1}</span>
      <code><span class="prompt-json-key">&quot;${escapeHtml(key)}&quot;</span><span class="prompt-json-punctuation">: </span><span class="prompt-json-string">&quot;${escapeHtml(value)}&quot;</span>${index === requestRows.length - 1 && !params.length ? '' : '<span class="prompt-json-punctuation">,</span>'}</code>
    </div>
  `).join('');
  const paramRows = params.map((entry, index) => `
    <div class="prompt-overview-code-line">
      <span class="prompt-overview-line-number">${requestRows.length + index + 1}</span>
      <code><span class="prompt-json-key">&quot;${escapeHtml(entry.key)}&quot;</span><span class="prompt-json-punctuation">: </span>${renderParamValue(entry)}${index === params.length - 1 ? '' : '<span class="prompt-json-punctuation">,</span>'}</code>
    </div>
  `).join('');
  const roleChips = roles.map(([role, count]) => (
    `<span class="prompt-overview-role-chip" data-prompt-role="${escapeHtml(role)}">${escapeHtml(role)} ×${count}</span>`
  )).join('');
  const metrics = [
    { label: '总响应耗时', value: formatDuration(diagnostics.latencyMs), note: '请求开始至 usage 返回' },
    { label: '首字延迟', value: firstTokenValue, note: req.stream ? '首个 provider 流片段' : '仅流式请求可测' },
    { label: '输出速度', value: tpsValue, note: '真实输出 token ÷ 首字后时长' },
    { label: '输出 Token', value: formatInt(diagnostics.completionTokens), note: '供应方 usage' },
    ...(diagnostics.webSearchRequests !== null && diagnostics.webSearchRequests !== undefined
      ? [{ label: '原生搜索次数', value: formatInt(diagnostics.webSearchRequests), note: webSearchEngine || '供应方 usage' }]
      : []),
    ...(diagnostics.webSearchTokens !== null && diagnostics.webSearchTokens !== undefined
      ? [{ label: '搜索 Token', value: formatInt(diagnostics.webSearchTokens), note: '供应方单独返回时记录' }]
      : []),
  ];

  const html = `
    <div class="prompt-overview-view">
      <div class="prompt-overview-intro">
        <span class="prompt-overview-kicker">REQUEST OVERVIEW · READ ONLY</span>
        <h2>本次请求概览</h2>
        <p>这里仅展示注入构成、请求配置与响应诊断；完整消息正文只在“完整 Prompt”分页出现。</p>
        <details class="prompt-overview-route${routeWarning ? ' is-warning' : ''}"${routeWarning ? ' open' : ''}>
          <summary>
            <strong><span>${escapeHtml(routeStateLabel)}</span> · <span>${escapeHtml(routeLayerLabel)}</span></strong>
            <span>${escapeHtml(req.provider || '未配置')} · ${escapeHtml(req.model || '未配置')}</span>
          </summary>
          <div>
            ${routeOptionFacts.length
              ? routeOptionFacts.map(item => `<code>${escapeHtml(item)}</code>`).join('')
              : `<code>${escapeHtml(translateUiText('本轮没有改变行为的结构化请求参数'))}</code>`}
            ${transportReason ? `<p>${escapeHtml(transportReason)}</p>` : ''}
            ${routeLayer === 'json_after_fc_circuit' ? '<p>FC 熔断后降级；JSON 使用独立健康状态。</p>' : ''}
          </div>
        </details>
        <div class="prompt-overview-chips">
          <span>${escapeHtml(req.provider || '未配置 provider')}</span>
          <span>${escapeHtml(req.model || '未配置 model')}</span>
          <span>${messages.length} 条消息</span>
          ${transportLabel ? `<span>${escapeHtml(transportLabel)}</span>` : ''}
          ${globalPromptBlocks.length ? `<span>全局提示词 ×${globalPromptBlocks.length}</span>` : ''}
          <span>${escapeHtml(at)}</span>
        </div>
        ${tokenAttributionAvailable ? `
          <div class="prompt-overview-token-attribution">
            <span>语义消息 ~${formatInt(semanticMessageEstimateTokens)} tok</span>
            <span>合同指令 ~${formatInt(contractInstructionEstimateTokens)} tok</span>
            <span>Schema ~${formatInt(schemaEstimateTokens)} tok</span>
          </div>
        ` : ''}
        ${(globalPromptBlocks.length || globalPromptSkipped.length) ? `
          <div class="prompt-overview-token-attribution">
            <span>全局提示词 ~${formatInt(globalPromptAudit.usedTokens)} tok</span>
            ${globalPromptSkipped.length ? `<span>护栏未注入 ${globalPromptSkipped.length} 块</span>` : ''}
          </div>
        ` : ''}
      </div>

      <div class="prompt-overview-layout">
        <section class="prompt-overview-panel prompt-overview-composition">
          <header class="prompt-overview-panel-head">
            <span class="prompt-overview-panel-icon" aria-hidden="true">◌</span>
            <span><strong>本次注入构成</strong><small>INJECTION COMPOSITION</small></span>
            ${Number.isFinite(estimatedInput) ? `<b>≈ ${formatInt(estimatedInput)} tok</b>` : ''}
          </header>
          <div class="prompt-overview-role-summary">
            ${roleChips || '<span class="prompt-overview-role-chip">暂无消息</span>'}
            ${headroom === null ? '' : `<span class="prompt-overview-headroom">余量 ${formatInt(headroom)} tok</span>`}
          </div>
          <div class="prompt-overview-usage">
            <div class="prompt-overview-usage-ring" style="--prompt-usage-angle:${usagePercent === null ? 0 : (usagePercent * 3.6).toFixed(2)}deg">
              <span><strong>${usagePercent === null ? '—' : `${usagePercent.toFixed(1)}%`}</strong><small>CONTEXT</small></span>
            </div>
            <dl>
              <div><dt>已注入</dt><dd>${formatInt(estimatedInput)} <small>tok</small></dd></div>
              <div><dt>输入预算</dt><dd>${formatInt(inputBudget)} <small>tok</small></dd></div>
              <div><dt>剩余空间</dt><dd>${formatInt(headroom)} <small>tok</small></dd></div>
            </dl>
          </div>
          ${injectionAuditHtml || '<div class="prompt-overview-empty">暂无本次注入审计记录</div>'}
        </section>

        <section class="prompt-overview-panel prompt-overview-request-card">
          <header class="prompt-overview-panel-head">
            <span class="prompt-overview-panel-icon" aria-hidden="true">{ }</span>
            <span><strong>请求配置</strong><small>REQUEST.JSONC · 不含消息正文</small></span>
            <span class="prompt-overview-readonly">readonly</span>
          </header>
          <div class="prompt-overview-code" role="region" aria-label="请求配置">
            <div class="prompt-overview-code-line is-brace"><span class="prompt-overview-line-number">0</span><code>{</code></div>
            ${requestJsonRows}${paramRows}
            <div class="prompt-overview-code-line is-brace"><span class="prompt-overview-line-number">${requestRows.length + params.length + 1}</span><code>}</code></div>
          </div>
          ${req.wireRequest?.body ? `
            <details class="prompt-overview-schema">
              <summary><strong>请求 JSON</strong></summary>
              <pre><code data-i18n-skip="true">${escapeHtml(truncateBase64(JSON.stringify(req.wireRequest.body, null, 2)))}</code></pre>
            </details>` : ''}
          ${req.wireRequest?.parameterReport?.length ? `
            <details class="prompt-overview-schema"><summary><strong>参数处理结果</strong></summary>${renderRequestParamReport(req.wireRequest.parameterReport)}</details>` : ''}
          ${terminalToolSchemaJson ? `
            <details class="prompt-overview-schema">
              <summary>
                <span><strong>结构化终态合同${terminalToolSchema.redacted === true ? ' · 终态工具 Schema（已脱敏）' : ''}${contractItemTypes.length ? ` · ${escapeHtml(contractItemTypes.join('/'))}` : ''}${contractTables.length ? ` · 可写表 ${contractTables.length}` : ''}</strong><small>${escapeHtml(terminalToolSchema.toolName || 'provider tool')}${schemaEstimateTokens === null ? '' : ` · ~${formatInt(schemaEstimateTokens)} tok`}</small></span>
                <b>展开</b>
              </summary>
              <p>目标身份由运行时冻结；本轮只接受唯一终态调用，并在完整领域校验后一次提交。</p>
              ${contractSummaryRows.length ? `
                <dl class="prompt-overview-contract-summary">
                  ${contractSummaryRows.map(([label, value, userData, valueHtml]) => `<div><dt>${escapeHtml(label)}</dt><dd${userData ? ' data-i18n-skip' : ''}>${valueHtml || escapeHtml(value)}</dd></div>`).join('')}
                </dl>
              ` : ''}
              <details class="prompt-overview-schema">
                <summary><span><strong>完整 Schema${terminalToolSchema.redacted === true ? '（已脱敏）' : ''}</strong><small>第二层</small></span><b>展开</b></summary>
                <pre><code>${escapeHtml(terminalToolSchemaJson)}</code></pre>
              </details>
            </details>
          ` : ''}
          ${jsonContract ? `
            <details class="prompt-overview-schema">
              <summary>
                <span><strong>JSON 输出合同</strong><small>${escapeHtml(jsonContract.formatMode || 'prompt_json')}${schemaEstimateTokens === null ? '' : ` · ~${formatInt(schemaEstimateTokens)} tok`}</small></span>
                <b>展开</b>
              </summary>
              <p>固定版本 ${escapeHtml(jsonContract.version || 'phone.reply.ir.v1')}；完整对象通过 IR、冻结目标与领域校验后才提交。</p>
              <details class="prompt-overview-schema">
                <summary><span><strong>完整 JSON Schema</strong><small>第二层</small></span><b>展开</b></summary>
                <pre><code>${escapeHtml(jsonContractJson)}</code></pre>
              </details>
            </details>
          ` : ''}
        </section>
      </div>

      <section class="prompt-overview-response">
        <header class="prompt-overview-section-head">
          <span><strong>响应性能</strong><small>真实 provider 数据；不可得时不估算</small></span>
          ${diagnostics.finishReason ? `<b>finish · ${escapeHtml(diagnostics.finishReason)}</b>` : ''}
        </header>
        <div class="prompt-overview-metrics">${metrics.map(renderMetricCard).join('')}</div>
        ${(responseIdentities.length ? responseIdentities : [['system fingerprint', providerUnavailable]]).map(([label, value]) => `
          <div class="prompt-overview-fingerprint">
            <span>${escapeHtml(label)}</span>
            <code title="${escapeHtml(value)}">${escapeHtml(value)}</code>
            <small>供应方响应身份 · 仅在响应提供时记录</small>
          </div>
        `).join('')}
        ${providerCallsJson ? `
          <details class="prompt-overview-schema">
            <summary>
              <span><strong>Provider calls · ${providerCalls.length}</strong><small>逐次分账${providerCallTotalTokens > 0 ? ` · 总计 ${formatInt(providerCallTotalTokens)} tok` : ''}</small></span>
              <b>展开</b>
            </summary>
            <pre><code>${escapeHtml(providerCallsJson)}</code></pre>
          </details>
        ` : ''}
      </section>
    </div>
  `;

  const plain = [
    '本次请求概览',
    `时间: ${at}`,
    `request id: ${req.requestId || '—'}`,
    `provider: ${req.provider || '—'}`,
    `model: ${req.model || '—'}`,
    `base url: ${req.baseUrl || '—'}`,
    `stream: ${req.stream ? 'true' : 'false'}`,
    `message count: ${messages.length}`,
    transportMode ? `transport: ${transportMode}${transportLabel ? ` (${transportLabel})` : ''}` : '',
    `route state: ${routePreviewState}`,
    routeLayer ? `route layer: ${routeLayer}` : '',
    routeOptionFacts.length ? `route options: ${routeOptionFacts.join('; ')}` : '',
    webSearchRoute ? `web search route: ${webSearchRoute}` : '',
    webSearchEnabled ? `web search execution: ${webSearchExecution || 'unknown'}` : '',
    webSearchEnabled ? `web search state: ${webSearchObservedState}` : '',
    webSearchEngine ? `web search engine: ${webSearchEngine}` : '',
    diagnostics.webSearchRequests !== null && diagnostics.webSearchRequests !== undefined
      ? `web search requests: ${formatInt(diagnostics.webSearchRequests)}`
      : '',
    diagnostics.webSearchTokens !== null && diagnostics.webSearchTokens !== undefined
      ? `web search tokens: ${formatInt(diagnostics.webSearchTokens)}`
      : '',
    transportReason ? `transport reason: ${transportReason}` : '',
    snapshotFingerprint ? `snapshot: ${snapshotFingerprint}` : '',
    hasTransportThinking ? `FC thinking requested: ${transport.thinkingRequested === true ? 'true' : 'false'}` : '',
    hasTransportThinking ? `FC thinking enabled: ${transport.thinkingEnabled === true ? 'true' : 'false'}` : '',
    transportThinkingOverrideReason ? `FC thinking override: ${transportThinkingOverrideReason}` : '',
    terminalToolSchema?.toolName
      ? `terminal tool schema: ${terminalToolSchema.toolName}${terminalToolSchema.redacted === true ? ' (redacted)' : ''}`
      : '',
    jsonContract ? `JSON terminal contract: ${jsonContract.version || 'phone.reply.ir.v1'} · ${jsonContract.formatMode || 'prompt_json'}` : '',
    schemaEstimateTokens !== null ? `schema estimate: ${formatInt(schemaEstimateTokens)} token` : '',
    semanticMessageEstimateTokens !== null ? `semantic messages estimate: ${formatInt(semanticMessageEstimateTokens)} token` : '',
    contractInstructionEstimateTokens !== null ? `contract instruction estimate: ${formatInt(contractInstructionEstimateTokens)} token` : '',
    globalPromptBlocks.length ? `global prompt blocks: ${globalPromptBlocks.length} · ${formatInt(globalPromptAudit.usedTokens)} token` : '',
    ...globalPromptSkipped.map(item => `global prompt skipped: ${item.name || item.id || '-'} · ${item.message || item.reason || '-'}`),
    ...contractSummaryRows.map(([label, value]) => `${label}: ${value}`),
    roles.length ? `roles: ${roles.map(([role, count]) => `${role} ×${count}`).join(', ')}` : '',
    req.wireRequest?.parameterReport?.length ? `parameter rules: ${req.wireRequest.parameterReport.map(item => `${item.name}: ${requestParamStatusLabel(item.status)}`).join(', ')}` : '',
    params.length ? `generation params: ${params.map(item => `${item.key}=${item.value}`).join(', ')}` : '',
    injectionAuditText,
    `total latency: ${formatDuration(diagnostics.latencyMs)}`,
    `first token latency: ${firstTokenValue}`,
    `output speed: ${tpsValue}`,
    `completion tokens: ${formatInt(diagnostics.completionTokens)}`,
    `system fingerprint: ${fingerprint || providerUnavailable}`,
    diagnostics.modelVersion ? `model version: ${String(diagnostics.modelVersion)}` : '',
    diagnostics.responseId ? `response id: ${String(diagnostics.responseId)}` : '',
    diagnostics.responseModel ? `response model: ${String(diagnostics.responseModel)}` : '',
    diagnostics.routedProvider ? `routed provider: ${String(diagnostics.routedProvider)}` : '',
    ...providerCalls.map(call => (
      `provider call #${call.callIndex}: ${call.mode || 'unknown'} · ${call.outcome || 'unknown'} · ${call.provider || 'unknown'}/${call.model || 'unknown'}`
    )),
  ].filter(Boolean).join('\n');

  return { html, plain };
};

const INLINE_TOKEN_RE = /(<\|[^|\n]*\|>|<\/?[A-Za-z_\u3400-\u9fff][^>\n]*>|\*\*[^*\n]+\*\*)/g;

const renderPromptInline = (line) => {
  const parts = String(line || '').split(INLINE_TOKEN_RE);
  return parts.map((part) => {
    if (!part) return '';
    if (part.startsWith('<|') && part.endsWith('|>')) {
      return `<span class="prompt-inline-token">${escapeHtml(part)}</span>`;
    }
    if (/^<\/?[A-Za-z_\u3400-\u9fff][^>\n]*>$/.test(part)) {
      return `<span class="prompt-inline-tag">${escapeHtml(part)}</span>`;
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return `<strong class="prompt-inline-bold">${escapeHtml(part.slice(2, -2))}</strong>`;
    }
    return escapeHtml(part);
  }).join('');
};

const roleLabel = (message, index) => {
  const role = String(message?.role || 'message').trim().toLowerCase() || 'message';
  const name = String(message?.name || '').trim();
  return {
    role,
    label: `[${role}] #${index + 1}${name ? ` · ${name}` : ''}`,
  };
};

export const buildFullPromptDocument = (request = null, { fallbackText = '' } = {}) => {
  const req = request && typeof request === 'object' ? request : {};
  const messages = Array.isArray(req.messages) ? req.messages : [];
  const globalPromptBlocks = Array.isArray(req.injectionAudit?.globalPrompt?.injected)
    ? req.injectionAudit.globalPrompt.injected
    : [];
  const globalPromptContentBlocks = globalPromptBlocks
    .map(block => ({
      block,
      content: String(block?.content || block?.renderedContent || ''),
    }))
    .filter(item => item.content);
  const blocks = messages.map((message, index) => {
    const role = roleLabel(message, index);
    const text = stringifyMessage(message);
    const globalPrompts = globalPromptContentBlocks
      .filter(item => String(text || '').includes(item.content))
      .map(item => item.block);
    const exactGlobalPrompt = globalPrompts.length === 1
      && String(text || '') === String(globalPrompts[0]?.content || globalPrompts[0]?.renderedContent || '')
      ? globalPrompts[0]
      : null;
    return {
      ...role,
      text,
      globalPrompts,
      exactGlobalPrompt,
      transportContract: /^(?:本轮使用 JSON 结构化终态|This turn uses the JSON structured terminal)/u.test(String(text || '').trim()),
    };
  });
  if (req.responsePrefix) {
    blocks.push({ role: 'assistant', label: '[assistant prefill]', text: String(truncateBase64(req.responsePrefix) || '') });
  }
  if (!blocks.length && String(fallbackText || '').trim()) {
    blocks.push({ role: 'message', label: '[prompt]', text: String(fallbackText) });
  }

  const plain = blocks.map(block => `${block.label}\n${block.text}`).join('\n\n');
  const rows = [];
  blocks.forEach((block, blockIndex) => {
    rows.push({ type: 'role', role: block.role, text: block.label });
    if (block.exactGlobalPrompt) {
      rows.push({
        type: 'global_prompt',
        role: block.role,
        text: block.text,
        name: block.exactGlobalPrompt.name || block.exactGlobalPrompt.id || '全局提示词',
        anchor: block.exactGlobalPrompt.anchor || '',
      });
    } else if (block.transportContract) {
      rows.push({ type: 'contract', role: block.role, text: block.text });
    } else {
      if (block.globalPrompts?.length) {
        rows.push({
          type: 'global_prompt_marker',
          role: block.role,
          text: block.globalPrompts.map(item => item.name || item.id || '全局提示词').join('、'),
        });
      }
      String(block.text || '').split(/\r?\n/).forEach((line) => rows.push({ type: 'content', role: block.role, text: line }));
    }
    if (blockIndex < blocks.length - 1) rows.push({ type: 'content', role: block.role, text: '' });
  });
  const estimatedTokens = toFiniteNumber(req.injectionAudit?.totalEstimateTokens ?? req.injectionAudit?.usedTokens);
  const lineRows = rows.map((row, index) => {
    const lineNumber = index + 1;
    if (row.type === 'role') {
      return `
        <div class="prompt-document-role" data-prompt-role="${escapeHtml(row.role)}" style="--prompt-line-index:${index}">
          <span class="prompt-document-line-number" data-prompt-line-number="${lineNumber}">${lineNumber}</span>
          <span class="prompt-document-rule"></span>
          <strong>${escapeHtml(row.text)}</strong>
          <span class="prompt-document-rule"></span>
        </div>
      `;
    }
    if (row.type === 'contract') {
      return `
        <div class="prompt-document-line is-transport-contract" style="--prompt-line-index:${index}">
          <span class="prompt-document-line-number" data-prompt-line-number="${lineNumber}">${lineNumber}</span>
          <details class="prompt-document-contract">
            <summary><strong>${escapeHtml(translateUiText('JSON 输出合同'))}</strong><small>${escapeHtml(translateUiText('传输层 · 展开查看实际发送内容'))}</small></summary>
            <pre><code>${escapeHtml(row.text)}</code></pre>
          </details>
        </div>
      `;
    }
    if (row.type === 'global_prompt') {
      return `
        <div class="prompt-document-line is-global-prompt" style="--prompt-line-index:${index}">
          <span class="prompt-document-line-number" data-prompt-line-number="${lineNumber}">${lineNumber}</span>
          <details class="prompt-document-contract" open>
            <summary><strong>${escapeHtml(translateUiText('全局提示词'))}</strong><small>${escapeHtml(row.name)}${row.anchor ? ` · ${escapeHtml(row.anchor)}` : ''}</small></summary>
            <pre><code>${escapeHtml(row.text)}</code></pre>
          </details>
        </div>
      `;
    }
    if (row.type === 'global_prompt_marker') {
      return `
        <div class="prompt-document-line is-global-prompt-marker" style="--prompt-line-index:${index}">
          <span class="prompt-document-line-number" data-prompt-line-number="${lineNumber}">${lineNumber}</span>
          <strong>${escapeHtml(translateUiText('全局提示词'))}</strong><small>${escapeHtml(row.text)}</small>
        </div>
      `;
    }
    const lineClass = row.text.startsWith('# ')
      ? ' is-heading'
      : row.text === 'NOTE:'
        ? ' is-note'
        : row.text.startsWith('- ')
          ? ' is-list'
          : '';
    return `
      <div class="prompt-document-line${lineClass}" style="--prompt-line-index:${index}">
        <span class="prompt-document-line-number" data-prompt-line-number="${lineNumber}">${lineNumber}</span>
        <code>${row.text === '' ? '&nbsp;' : renderPromptInline(row.text)}</code>
      </div>
    `;
  }).join('');

  const html = `
    <section class="prompt-full-browser">
      <header class="prompt-full-heading">
        <div class="prompt-full-heading-icon" aria-hidden="true">¶</div>
        <div>
          <span class="prompt-overview-kicker">ASSEMBLED PROMPT · READ ONLY</span>
          <h2>完整 Prompt</h2>
          <p>所有消息按实际发送顺序展开；行号仅用于浏览，不会进入请求。</p>
        </div>
        <div class="prompt-full-stats">
          <span>${formatInt(rows.length)} 行</span>
          <span>${formatInt(plain.length)} 字符</span>
          ${Number.isFinite(estimatedTokens) ? `<span>≈ ${formatInt(estimatedTokens)} tok</span>` : ''}
        </div>
        <button type="button" class="prompt-full-wrap is-active" data-prompt-wrap-toggle aria-pressed="true">
          <span aria-hidden="true">↩</span>自动换行<i></i>
        </button>
        <button type="button" class="prompt-full-copy" data-prompt-copy-all>复制全文</button>
      </header>
      <div class="prompt-document-shell" data-prompt-document>
        <div class="prompt-document-titlebar">
          <span class="prompt-document-status" aria-hidden="true"></span>
          <code>assembled_prompt.txt · utf-8</code>
          <span>readonly</span>
        </div>
        <div class="prompt-document-scroll">
          <div class="prompt-document-lines">${lineRows || `<div class="prompt-overview-empty">${escapeHtml(translateUiText('暂无 Prompt 内容'))}</div>`}</div>
        </div>
      </div>
      <footer class="prompt-document-end"><span></span>END OF PROMPT<span></span></footer>
    </section>
  `;

  return {
    html,
    plain,
    lineCount: rows.length,
    charCount: plain.length,
    messageCount: blocks.length,
  };
};
