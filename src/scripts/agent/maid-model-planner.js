import {
  findAppFeature,
  getMaidModelFeatureContext,
  listAppFeatures,
} from './app-feature-catalog.js';
import { resolveCandidateCapabilitySelection } from './maid-capability-routing.js';
import { buildMaidSkillIndexPrompt } from './maid-skill-catalog.js';
import {
  buildMaidImageAttachmentSummary,
  buildMaidUserContentWithImages,
  getMaidImageAttachmentsFromContext,
} from './maid-attachment-parts.js';
import {
  buildMaidImageGenerationContextPromptBlock,
  normalizeMaidImageGenerationContext,
} from './maid-image-generation-context.js';
import { buildMaidRunContinuationPromptBlock } from './maid-run-continuation.js';
import { buildMaidSourceGroundingPromptBlock } from './maid-source-grounding.js';
import { buildMaidVisualSpecPromptBlock } from './maid-visual-spec.js';
import { isMaidUserAbort } from './maid-failure-codes.js';
import { buildMaidGenerationOptions } from './maid-generation-settings.js';
import { MAID_MEMORY_REFERENCE_RULE, buildMaidMemoryPromptBlock } from './maid-memory-prompt.js';
import {
  MAID_PROMPTED_JSON_MODE,
  MAID_PROVIDER_FC_MODE,
  MAID_PROVIDER_FC_MESSAGE_MAX_LENGTH,
  runMaidProviderFcAttempt,
} from './maid-provider-fc-planner.js';
import {
  DEFAULT_MAID_PROMPT,
  getLocalizedMaidOperationSafetyPrompt,
  getLocalizedMaidOutputLanguagePrompt,
  getLocalizedMaidPrompt,
} from './maid-prompt-defaults.js';
import { buildMaidSelectionPromptBlock } from '../ui/maid-selection-utils.js';
import { getVisionInputCapability } from '../api/vision-capabilities.js';
import {
  GLOBAL_SEMANTIC_PROMPT_ANCHORS,
  resolveGlobalSemanticPromptPlan,
} from './global-semantic-prompt-library.js';

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const resolveMaidConversationContextSnapshot = ({
  getConversationContext = null,
  input = '',
  context = {},
  taskType = 'maid_assistant',
} = {}) => {
  const sharedRef = isPlainObject(context?.maidConversationContextRef)
    ? context.maidConversationContextRef
    : null;
  if (isPlainObject(sharedRef?.current)) return sharedRef.current;
  const snapshot = typeof getConversationContext === 'function'
    ? getConversationContext({ input, context, taskType })
    : (isPlainObject(context?.maidConversationContext) ? context.maidConversationContext : null);
  if (sharedRef && isPlainObject(snapshot)) sharedRef.current = snapshot;
  return snapshot;
};

const clone = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return Array.isArray(value) ? value.slice() : { ...value };
  }
};

const list = value => (Array.isArray(value) ? value : [value])
  .map(item => trim(item))
  .filter(Boolean);

const emitDebugSnapshot = (callback, payload = {}, logger = console) => {
  if (typeof callback !== 'function') return;
  try {
    callback(payload);
  } catch (error) {
    logger?.debug?.('maid model planner debug snapshot failed', error);
  }
};

// 主档故障降级：主模型请求失败（网络/5xx/403 等）时用备用档重试一次
/* 临时故障（限流、5xx、超时/网络、空响应、鉴权令牌获取失败）先对同一模型退避重试，再转备用档；
   没配备用档就报错。参数错误、无权限等不会因重试而改变的错误不重试。 */
let maidModelRetryDelaysMs = [1200, 3000];
export const configureMaidModelRetry = ({ delaysMs } = {}) => {
  if (Array.isArray(delaysMs)) maidModelRetryDelaysMs = delaysMs.map(value => Math.max(0, Number(value) || 0));
  return [...maidModelRetryDelaysMs];
};

export const isMaidTransientModelError = (error = null) => {
  const status = Number(error?.status || error?.statusCode || 0);
  if ([408, 409, 425, 429].includes(status) || (status >= 500 && status < 600)) return true;
  if (status >= 400 && status < 500) return false;
  const text = String(error?.message || error || '');
  if (/\b(?:400|401|403|404|422)\b/.test(text) && !/\b(?:429|5\d\d)\b/.test(text)) return false;
  return /\b(?:429|5\d\d)\b|resource (?:has been )?exhausted|rate.?limit|overloaded|temporarily|unavailable|timed? ?out|timeout|network|fetch failed|ECONN|socket|empty response|failed to authenticate with service account/i.test(text);
};

const waitWithSignal = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' })); return; }
  const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' })); };
  signal?.addEventListener?.('abort', onAbort, { once: true });
});

const chatWithFallback = async (
  client,
  fallbackClient,
  messages,
  options = {},
  logger = console,
  onClientUsed = null,
  onModelUsage = null,
) => {
  // 现场探针：挂起时读 globalThis.__maidModelProbe 定位——phase=calling 且 elapsed 大 = 请求发出后渠道 hang
  const startedAt = Date.now();
  const probe = { phase: 'calling', startedAt, options: { maxTokens: options?.maxTokens } };
  try { globalThis.__maidModelProbe = probe; } catch {}
  // Phase B 计量：out-of-band 采集 provider usage，不改 client.chat 返回契约（仍返回文本）。
  const wantUsage = typeof onModelUsage === 'function';
  // maidGeneration = { settings, primaryModel, fallbackModel }：思考参数按实际调用的模型分别生成，降级档不会收到主档的参数
  const { maidGeneration = null, ...requestOptions } = options || {};
  const requireText = response => {
    if (!trim(response)) throw new Error('Empty response from maid model');
    return response;
  };
  // 每次尝试独立记账；一次请求内的 usage 回调可能是累计值，只保留该次最后一份。
  const callAttempt = async (targetClient, model, degraded) => {
    const attemptStartedAt = Date.now();
    let capturedUsage = null;
    let failed = false;
    const baseOptions = wantUsage
      ? { ...requestOptions, onProviderUsage: usage => { capturedUsage = usage; } }
      : requestOptions;
    try {
      return requireText(await targetClient.chat(messages, buildMaidGenerationOptions(baseOptions, model, maidGeneration?.settings)));
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (wantUsage) {
        try {
          onModelUsage({
            provider: model?.provider, model: model?.model,
            ...(capturedUsage || {}),
            latencyMs: Date.now() - attemptStartedAt, modelCallCount: 1, degraded,
            ...(failed ? { outcome: 'provider_request_failed' } : {}),
          });
        } catch {}
      }
    }
  };
  const callPrimaryWithRetry = async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await callAttempt(client, maidGeneration?.primaryModel, false);
      } catch (error) {
        const delay = maidModelRetryDelaysMs[attempt];
        if (isMaidUserAbort(error, options?.signal) || delay === undefined || !isMaidTransientModelError(error)) throw error;
        logger?.warn?.(`[maid-model] transient failure, retry ${attempt + 1} in ${delay}ms: ${String(error?.message || error).slice(0, 120)}`);
        await waitWithSignal(delay, options?.signal);
      }
    }
  };
  try {
    const text = await callPrimaryWithRetry();
    probe.phase = 'done';
    probe.doneAt = Date.now();
    probe.elapsedMs = probe.doneAt - startedAt;
    try { onClientUsed?.('primary'); } catch {}
    return text;
  } catch (error) {
    probe.phase = 'failed';
    probe.error = String(error?.message || error).slice(0, 120);
    probe.elapsedMs = Date.now() - startedAt;
    logger?.warn?.(`[maid-model] chat failed after ${probe.elapsedMs}ms: ${probe.error}`);
    // 用户取消不属于主档故障，绝不转 fallback 重试（会多计费一次）
    if (isMaidUserAbort(error, options?.signal)) {
      throw error;
    }
    if (!fallbackClient || typeof fallbackClient.chat !== 'function') {
      throw error;
    }
    probe.phase = 'fallback-calling';
    logger?.warn?.('maid main model failed, retrying with fallback profile');
    try {
      try { onClientUsed?.('fallback'); } catch {}
      const text = await callAttempt(fallbackClient, maidGeneration?.fallbackModel, true);
      probe.phase = 'fallback-done';
      probe.elapsedMs = Date.now() - startedAt;
      return text;
    } catch (err2) {
      probe.phase = 'fallback-failed';
      probe.error = String(err2?.message || err2).slice(0, 120);
      probe.elapsedMs = Date.now() - startedAt;
      throw err2;
    }
  }
};

const maidGenerationFor = (runtime = {}, config = {}) => ({
  settings: runtime?.generationSettings || null,
  primaryModel: config,
  fallbackModel: isPlainObject(runtime?.fallbackConfig) ? runtime.fallbackConfig : {},
});

const hasImageParts = (messages = []) => (Array.isArray(messages) ? messages : []).some(message => (
  Array.isArray(message?.content) && message.content.some(part => part?.type === 'image_url')
));

const resolveFallbackClientForMessages = (runtime = {}, messages = []) => {
  const fallbackClient = runtime?.fallbackClient || null;
  if (!fallbackClient || !hasImageParts(messages)) return fallbackClient;
  const config = isPlainObject(runtime?.fallbackConfig) ? runtime.fallbackConfig : {};
  const capability = getVisionInputCapability({
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
  });
  return capability.supported ? fallbackClient : null;
};

const unsupportedPlan = (reason = 'unsupported_intent', message = '这个请求还没有接入女仆工具。', details = {}) => ({
  ok: false,
  status: 'unsupported',
  reason,
  message,
  ...(isPlainObject(details) ? details : {}),
});

const truncate = (value = '', max = 240) => {
  const text = trim(value);
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max)}...`;
};

const stringifyForPrompt = (value, max = 10000) => {
  try {
    return truncate(JSON.stringify(value, null, 2), max);
  } catch {
    return truncate(String(value ?? ''), max);
  }
};

/* 最近步骤的观察按“新的优先”分配字数：整段序列化后从尾部截断会先截掉最新一步，
   一次很大的读取就会让模型看不到刚完成的写入，于是重复执行。每步单独序列化，
   最新一步至少 7000 字（前面步骤少时可用到剩余预算）、更早的每步最多 3000 字，总量不超过 budget；步骤头（工具、参数、状态、摘要）在前，截断只削减输出。 */
/* 超出字数时按结构精简而不是从尾部硬切：逐级缩短长数组（保留开头几项并注明省略数）、截短长字符串，
   让数量、摘要等顶层字段始终可见；仍放不下才退回硬截断。 */
const shrinkForPrompt = (value, maxItems, maxString) => {
  if (typeof value === 'string') return value.length > maxString ? `${value.slice(0, maxString)}…` : value;
  if (Array.isArray(value)) {
    const kept = value.slice(0, maxItems).map(item => shrinkForPrompt(item, maxItems, maxString));
    return value.length > maxItems ? [...kept, `…还有 ${value.length - maxItems} 项未显示`] : kept;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrinkForPrompt(item, maxItems, maxString)]));
  }
  return value;
};

export const compactJsonForPrompt = (value, max = 10000) => {
  // 观察用紧凑 JSON（缩进只占字数与 token，不增加信息）
  const toText = (item) => { try { return JSON.stringify(item); } catch { return null; } };
  let text = toText(value);
  if (text === null) return truncate(String(value ?? ''), max);
  if (text.length <= max) return text;
  // 先截短长字符串，再二分出能放下的最多数组项数，尽量少省略
  for (const maxString of [600, 240, 120, 60]) {
    let low = 1;
    let high = 200;
    let best = null;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = toText(shrinkForPrompt(value, mid, maxString));
      if (candidate !== null && candidate.length <= max) { best = candidate; low = mid + 1; } else high = mid - 1;
    }
    if (best) return best;
  }
  return truncate(text, max);
};

const isReadLikeStepTool = (toolName = '') => /^(?:list|read|get|search|find|inspect|query|describe|view)(?:_|$)/
  .test(trim(toolName).split('.').pop() || '');

// 同一轮里用相同参数重复读取、结果也完全相同时，旧的那次只留一句指向最新一次（最新一步预算最大，信息不丢）
const findLaterIdenticalReads = (list = []) => {
  const latestByKey = new Map();
  const laterIndex = new Map();
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const step = list[index];
    if (!isReadLikeStepTool(step?.toolName) || trim(step?.status) !== 'succeeded' || step?.output === undefined) continue;
    let key = '';
    try { key = `${trim(step.toolName)}\u0000${JSON.stringify(step.args ?? {})}\u0000${JSON.stringify(step.output)}`; } catch { continue; }
    if (latestByKey.has(key)) laterIndex.set(index, latestByKey.get(key));
    else latestByKey.set(key, Number(step?.index) || index + 1);
  }
  return laterIndex;
};

export const stringifyRecentStepsForPrompt = (steps = [], budget = 12000, { latestMax = 7000, olderMax = 3000 } = {}) => {
  const list = Array.isArray(steps) ? steps : [];
  if (!list.length) return '';
  const parts = [];
  let remaining = Math.max(0, budget);
  // 最新一步至少 latestMax；前面步骤少时把省下的预算也给它（只有一步时可用满预算）
  const latestCap = Math.max(latestMax, budget - (list.length - 1) * olderMax);
  const repeatedLater = findLaterIdenticalReads(list);
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const step = list[index];
    const cap = Math.min(remaining, index === list.length - 1 ? latestCap : olderMax);
    const text = repeatedLater.has(index)
      ? `{ "index": ${Number(step?.index) || index + 1}, "toolName": ${JSON.stringify(trim(step?.toolName))}, "status": "succeeded", "output": ${JSON.stringify(`与第 ${repeatedLater.get(index)} 步的参数和结果完全相同（重复读取），见该步`)} }`
      : cap >= 300
      ? compactJsonForPrompt(step, cap)
      : `{ "index": ${Number(step?.index) || index + 1}, "toolName": ${JSON.stringify(trim(step?.toolName))}, "status": ${JSON.stringify(trim(step?.status))}, "summary": ${JSON.stringify(truncate(trim(step?.summary), 90))} }`;
    parts.unshift(text);
    remaining = Math.max(0, remaining - text.length);
  }
  return `[\n${parts.join(',\n')}\n]`;
};

const MAID_READ_LEDGER_TOOLS = new Set([
  'app.read_resource',
  'worldbook.read',
  'worldbook.list',
  'session.list',
  'app.get_current_state',
  'chat.read_format_profile',
  'maid.todo.read',
]);

const compactMaidReadLedgerFacts = (step = {}) => {
  const output = isPlainObject(step?.output) ? step.output : {};
  const toolName = trim(step?.toolName);
  if (
    toolName === 'app.read_resource' &&
    trim(output.resource).toLowerCase() === 'persona' &&
    Array.isArray(output.items)
  ) {
    return {
      resource: 'persona',
      items: output.items.slice(0, 8).map(item => ({
        name: trim(item?.name || item?.id),
        associations: isPlainObject(item?.associations) ? {
          worldbookId: trim(item.associations.worldbookId),
          worldbookEnabled: item.associations.worldbookEnabled,
          systemPresetId: trim(item.associations.systemPresetId),
          regexSetId: trim(item.associations.regexSetId),
        } : undefined,
      })),
    };
  }
  if (toolName === 'worldbook.read') {
    return {
      name: trim(output.name || output.id || step?.args?.name || step?.args?.worldbookId),
      entryCount: Number.isFinite(Number(output.entryCount)) ? Number(output.entryCount) : undefined,
      titles: (Array.isArray(output.entries) ? output.entries : [])
        .slice(0, 3)
        .map(entry => trim(entry?.title || entry?.comment || entry?.name))
        .filter(Boolean),
    };
  }
  return {
    summary: trim(step?.summary),
  };
};

const buildMaidSuccessfulReadLedger = (steps = []) => {
  const records = new Map();
  (Array.isArray(steps) ? steps : []).forEach((step, index) => {
    const toolName = trim(step?.toolName);
    if (step?.status !== 'succeeded' || !MAID_READ_LEDGER_TOOLS.has(toolName)) return;
    let argsText = '{}';
    try {
      argsText = JSON.stringify(isPlainObject(step?.args) ? step.args : {});
    } catch {}
    const key = `${toolName}:${argsText}`;
    const existing = records.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastIndex = index;
      return;
    }
    let factsText = '{}';
    try {
      factsText = JSON.stringify(compactMaidReadLedgerFacts(step));
    } catch {}
    records.set(key, {
      toolName,
      argsText: truncate(argsText, 360),
      factsText: truncate(factsText, 720),
      count: 1,
      lastIndex: index,
    });
  });
  const rows = Array.from(records.values())
    .sort((left, right) => left.lastIndex - right.lastIndex)
    .slice(-16)
    .map((item, index) => (
      `${index + 1}. ${item.toolName} args=${item.argsText} facts=${item.factsText}` +
      (item.count > 1 ? ` repeated=${item.count}` : '')
    ));
  return rows.length ? rows.join('\n') : '';
};

// 可用 sub-agent 模型（能力标签制）：女仆看到的是能力描述而非模型名，按任务匹配选择。
export const buildMaidSubAgentsPromptBlock = (subAgents = []) => {
  const list = (Array.isArray(subAgents) ? subAgents : []).filter(item => item?.enabled !== false);
  if (!list.length) return '';
  const lines = list.map(item => [
    `- id: ${item.id}`,
    `  name: ${item.name}`,
    item.skills?.length ? `  skills: [${item.skills.join(', ')}]` : '',
    item.note ? `  note: ${item.note}` : '',
    item.profileHint ? `  profile: ${item.profileHint}` : '',
  ].filter(Boolean).join('\n')).join('\n');
  return [
    '<sub_agents>',
    '以下是用户配置的 sub-agent 模型（按能力标签选择，委派型工具可传 subAgentId 使用；重内容生成类任务优先委派以节省主模型消耗）：',
    lines,
    '</sub_agents>',
  ].join('\n');
};

// 功能目录用 YAML 列表呈现（层次清晰、便于模型定位字段），外层由 <app_features> 标签分隔。
const yamlText = (value = '') => {
  const text = trim(value);
  if (!text) return "''";
  return /[:#\[\]{}\n"']/g.test(text) ? JSON.stringify(text) : text;
};

export const buildMaidModelPlannerFeatureList = (features = listAppFeatures(), {
  includeSchemas = true,
  includeAliases = true,
} = {}) => (
  getMaidModelFeatureContext(features).features
    .map(feature => [
      `- id: ${yamlText(feature.id)}`,
      `  title: ${yamlText(feature.title)}`,
      `  tools: [${list(feature.tools).map(yamlText).join(', ')}]`,
      includeSchemas && isPlainObject(feature.toolSchemas) && Object.keys(feature.toolSchemas).length
        ? `  schemas: ${JSON.stringify(feature.toolSchemas)}`
        : '',
      feature.argsHint ? `  args: ${yamlText(feature.argsHint)}` : '',
      feature.writes === true ? '  writes: true' : '',
      trim(feature.riskLevel, 'low') !== 'low' ? `  risk: ${yamlText(feature.riskLevel)}` : '',
      trim(feature.panel) ? `  panel: ${yamlText(feature.panel)}` : '',
      includeAliases && list(feature.aliases).length ? `  aliases: [${list(feature.aliases).slice(0, 8).map(yamlText).join(', ')}]` : '',
      list(feature.uiPath).length ? `  path: ${yamlText(list(feature.uiPath).join(' -> '))}` : '',
    ].filter(Boolean).join('\n'))
    .join('\n')
);

// 需要先让用户确认删除清单时（例如用户记忆里有“删除前先确认”的偏好），必须用 preview 生成结构化清单，
// 用户下一句确认后 APP 按该清单原样执行；只用文字询问会让确认后无法执行
const MAID_DELETE_PREVIEW_RULE = '如果需要先让用户确认要删除的清单（例如用户偏好要求删除前先确认），调用对应的删除工具并传 preview:true 生成待确认清单（不会删除），再在回复里请用户确认；用户确认后 APP 会按这份清单执行。不要只用文字询问。';

/* 功能目录分层注入：本地检索排名最靠前的少数功能给完整参数，其余全部功能只列“id: 名称”索引。
   模型需要索引里的功能时先用 app.read_feature_doc 读取说明（下一步该功能会进入候选），
   避免每次调用都带上整本功能目录。 */
export const MAID_PROMPT_FEATURE_DETAIL_LIMIT = 4;
const ALWAYS_DETAILED_FEATURE_IDS = new Set(['app.capabilities.search']);

export const buildMaidFeatureCatalogPrompt = ({
  features = [],
  featureIndex = null,
  includeSchemas = true,
  detailLimit = MAID_PROMPT_FEATURE_DETAIL_LIMIT,
} = {}) => {
  const ranked = getMaidModelFeatureContext(features).features;
  const top = ranked.filter(feature => !ALWAYS_DETAILED_FEATURE_IDS.has(feature.id)).slice(0, Math.max(1, detailLimit));
  const detailed = [...top, ...ranked.filter(feature => ALWAYS_DETAILED_FEATURE_IDS.has(feature.id))];
  const detailedIds = new Set(detailed.map(feature => feature.id));
  // 索引列出全部功能且顺序固定：它属于不变的提示词前缀，不能随本次候选变化，否则服务商的提示词缓存命中不了
  const indexSource = getMaidModelFeatureContext(Array.isArray(featureIndex) && featureIndex.length ? featureIndex : features).features;
  const indexLines = indexSource.map(feature => `- ${feature.id}: ${trim(feature.title, feature.id)}`);
  const staticText = [
    '## APP 功能目录',
    '<app_feature_index> 列出全部功能的名称；用户消息开头的 <app_features> 给出与本次请求最相关功能的完整参数，可以直接选用。',
    '需要不在 <app_features> 里的功能时，先调用 app.read_feature_doc 并传 featureId 读取它的工具与参数，下一步再使用；不要凭名称猜测工具名或参数。',
    indexLines.length ? `<app_feature_index>\n${indexLines.join('\n')}\n</app_feature_index>` : '',
    indexSource.some(feature => feature.tools?.includes('app.read_skill')) ? buildMaidSkillIndexPrompt() : '',
  ].filter(Boolean).join('\n');
  // 别名只服务于本地检索匹配，模型选择工具用不到
  const detailText = `<app_features>\n${buildMaidModelPlannerFeatureList(detailed, { includeSchemas, includeAliases: false })}\n</app_features>`;
  return {
    detailedIds: [...detailedIds],
    staticText,
    detailText,
    text: `${staticText}\n${detailText}`,
  };
};

export const buildMaidModelPlannerMessages = ({
  input = '',
  context = {},
  conversationContext = null,
  features = listAppFeatures(),
  maidPrompt = DEFAULT_MAID_PROMPT,
  transportMode = MAID_PROMPTED_JSON_MODE,
  globalSemanticPromptPlan = null,
  featureIndex = null,
} = {}) => {
  const modelFeatureContext = getMaidModelFeatureContext(features);
  const providerFc = trim(transportMode).toLowerCase() === MAID_PROVIDER_FC_MODE;
  const featureCatalog = buildMaidFeatureCatalogPrompt({ features, featureIndex, includeSchemas: !providerFc });
  const prompt = getLocalizedMaidPrompt(trim(maidPrompt, DEFAULT_MAID_PROMPT));
  const memoryText = trim(conversationContext?.memoryText);
  const historyText = trim(conversationContext?.historyText);
  const imageAttachments = getMaidImageAttachmentsFromContext(context);
  const imageSummary = buildMaidImageAttachmentSummary(imageAttachments);
  const selectionBlock = buildMaidSelectionPromptBlock(context?.userSelection);
  const subAgentsBlock = buildMaidSubAgentsPromptBlock(context?.subAgents);
  const imageGenerationBlock = buildMaidImageGenerationContextPromptBlock(context?.imageGenerationContext);
  const runContinuationBlock = buildMaidRunContinuationPromptBlock(context?.runContinuation);
  const sourceGroundingBlock = buildMaidSourceGroundingPromptBlock({
    input,
    steps: context?.maidReactSteps,
  });
  const visualSpecBlock = buildMaidVisualSpecPromptBlock(context?.maidVisualSpecLedger);
  // 会变的内容（本次候选的完整参数）放在用户消息开头，系统提示保持不变以命中服务商的提示词缓存
  const userText = [
    featureCatalog.detailText,
    `用户请求：${trim(input)}`,
    runContinuationBlock,
    sourceGroundingBlock,
    visualSpecBlock,
    selectionBlock,
    subAgentsBlock,
    imageSummary ? `用户附图：\n${imageSummary}` : '',
    imageGenerationBlock,
    `当前会话：${trim(context?.sessionId, '-')}`,
    `UI 模式：${trim(context?.uiMode, '-')}`,
    `当前页面：${trim(context?.activePage, '-')}`,
    `界面呈现意图：${trim(context?.presentationIntent?.mode, 'background')}`,
    buildMaidMemoryPromptBlock({ memoryText, historyText }),
  ].filter(Boolean).join('\n');
  const systemMessage = {
      role: 'system',
      content: [
        '你是这个 APP 内的女仆助手规划器。',
        modelFeatureContext.awareness,
        '',
        '## 输出协议',
        ...(providerFc ? [
          '本轮 API 已提供当前候选范围内的 APP 函数。需要执行动作时必须调用且只调用一个业务函数，不要输出参数文本。',
          '如果不应执行 APP 工具、需要澄清、无法支持，或已经可以直接回答，只调用 maid_planner_control。',
          '不要输出函数参数、格式样例或额外解释文字；选择业务函数后的执行前提示由 APP 本地生成。',
        ] : [
          '你只能从给定 APP 功能目录中选择一个功能，并输出严格 JSON，不能输出解释文字。',
          '允许格式一：{"ok":true,"toolName":"工具名","args":{},"featureId":"功能id","title":"短标题","response":"给用户的自然短回复"}',
          '允许格式二：{"ok":false,"reason":"unsupported_intent","message":"短原因"}',
          '不要把工具 JSON 放进 response；response 只写执行前给用户看的短句。工具 JSON 必须是整条回复的唯一顶层 JSON。',
        ]),
        '',
        '## 工具与参数规则',
        '限制：不要发明工具；不要删除、覆盖或修改高风险数据；配置写入类动作只允许打开界面，不允许直接修改配置。',
        '工具 args 必须是完整、具体、可直接执行的 JSON；不要使用 "__keep_existing"、"同上"、"省略"、"待补" 等占位值。需要旧内容时先调用读取工具。',
        '如果用户询问当前、最新、公开网络资料，允许选择联网搜索工具；如果用户询问 APP 内资料，优先选择 APP 读取工具，不要联网。',
        '任务规划判据：todo 只用于跨 3 个及以上不同功能域、且包含写入、生成或较长处理链的复杂任务；多个结构化资源的只读比较不需要 todo，直接选择第一个具体读取工具。打开→检查→点击这类短界面序列也直接执行，不要为它写清单。',
        '界面呈现原则：普通查询与操作默认在后台执行，不要主动打开面板、进入聊天室或切换页面；查询、查看、检查等词不等于要求打开界面。只有用户明确要求打开、进入、带他去看，或任务本身必须由用户在界面继续填写时才导航。',
        '批量任务即使用户要求展示，也只展示最终的主要结果，不要逐项打开重复或次要页面；带 open 参数的工具默认传 false，明确要求展示时才传 true。',
        '例外：chat.send_message 的 user 消息在 triggerReply:true 时会走正常回复链，当前实现必须进入目标聊天室并传 open:true；只有 triggerReply:false 的纯消息写入才能 open:false 后台追加。',
        '教我、一步步、引导等教学请求与普通展示不同：APP 的内建新手任务由本地流程处理；功能首次引导由执行层处理，不要把普通后台任务改写成界面教学。',
        '如果用户要求把附图设置为头像或壁纸，选择对应头像/壁纸工具；工具参数只传 target/name/sessionId/attachmentId 等小字段，不要把 base64 或图片 data URL 写进 args。省略 attachmentId 时工具会使用第一张附图。',
        '调用 media.generate_image 时必须完整传 subject、subjectAliases（提示词使用别名时）、target、purpose、appearance、outfit、style、targetAspectRatio；subject 或别名必须实际出现在 prompt。后续同一主体必须复用 <maid_visual_specs> 的外貌、服装与画风，不得自行改写。',
        '生成头像/壁纸时，target 必须精确对应随后写回的角色、联系人或聊天室；当前生图尺寸与 targetAspectRatio 不符时先停下说明，不要把错误比例图片写回。',
        '如果 <user_selection> 提供区域ID，且用户询问图片内容、布局、配色、错位、重叠或遮挡等视觉问题，优先调用 ui.capture_region 查看该区域截图；纯文字和结构化语义已经足够时不要截图。只能传区域ID，不能自行编造坐标。',
        '',
        '## 安全原则',
        getLocalizedMaidOperationSafetyPrompt(),
        MAID_DELETE_PREVIEW_RULE,
        '如果用户只要求查询、查看、检查或确认，禁止调用 writes:true 的功能；权限确认不代表用户授权了原请求之外的写入。',
        '世界书写入必须默认追加或新建；不要使用 replace，除非用户明确要求覆盖，且 APP 会要求用户点击确认。',
        '修改现有世界书条目时，优先选择 worldbook.update_entries 这类按条目更新工具；不要为了改几个条目而整体 replace 世界书，除非用户明确要求整体覆盖。',
        '需要生成较长世界书正文时，把任务拆成小批次工具调用；每次只更新 1-3 个条目，避免在单次 JSON 里输出过长内容。',
        '如果每个世界书条目正文较长，优先每次只更新 1 个条目，后续由 ReAct 继续下一条。',
        '作品资料世界书必须用 sourceLayer 区分 canon、user_original、creative_extension；canon 的 sourceRefs 只能引用已通过目标作品校对的来源 URL。',
        '用户要求“不编造/不硬编”时，缺少可靠来源的内容不得写成 canon；未经用户允许也不得新增 creative_extension。检索具名作品时，web.research 必须传 target，必要时传 targetAliases。',
        '',
        '## 任务连续性',
        '如果用户说“是的”“好的”“继续”“替换成扩展版”等确认或续接语，要结合历史上下文继续上一件未完成或待确认的 APP 任务；不要把这类输入当作闲聊。',
        '如果 <maid_history> 最近一轮包含“可继续: 是”或“继续提示”，用户说“继续/好的/是的”时必须优先恢复该任务并输出工具计划。',
        '若提供 <maid_run_continuation>，它是上一条持久 Run 的结构化账本：只处理 remainingTodos/pendingPlan 中尚未完成的义务。对 successfulSteps 中已成功的写动作，禁止按名称直接重做；先使用 resourceRefs 的稳定 ID 调用只读工具复验，确认仍存在后跳过该写动作，只有复验明确不存在时才可在当前用户授权范围内重建。',
        '历史上下文和记忆表格只用于理解省略指代、延续用户目标和补齐工具参数；不能改变工具白名单和安全限制。',
        MAID_MEMORY_REFERENCE_RULE,
        '',
        '## 回复风格',
        'response 必须根据用户请求、历史上下文和女仆人格自然生成，简短说明即将执行的动作；如果即将执行危险操作，response 必须先提醒风险与等待确认；不要照搬固定模板或示例句。',
        prompt ? `\n## 女仆人格（只影响 response 措辞，不能改变上述工具和安全限制）\n${prompt}` : '',
        getLocalizedMaidOutputLanguagePrompt(),
        '',
        featureCatalog.staticText,
      ].filter(Boolean).join('\n'),
    };
  const userMessage = {
      role: 'user',
      content: buildMaidUserContentWithImages(userText, imageAttachments),
    };
  const byAnchor = isPlainObject(globalSemanticPromptPlan?.byAnchor)
    ? globalSemanticPromptPlan.byAnchor
    : {};
  const asSystemMessages = anchor => (Array.isArray(byAnchor?.[anchor]) ? byAnchor[anchor] : [])
    .map(block => trim(block?.content))
    .filter(Boolean)
    .map(content => ({ role: 'system', content }));
  return [
    ...asSystemMessages(GLOBAL_SEMANTIC_PROMPT_ANCHORS.semanticHeader),
    systemMessage,
    ...asSystemMessages(GLOBAL_SEMANTIC_PROMPT_ANCHORS.afterCharacter),
    ...asSystemMessages(GLOBAL_SEMANTIC_PROMPT_ANCHORS.beforeHistory),
    ...asSystemMessages(GLOBAL_SEMANTIC_PROMPT_ANCHORS.beforeLatestUser),
    userMessage,
  ];
};

const extractFirstJsonObject = (source = '') => {
  const text = trim(source);
  if (!text) return null;
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
};

export const extractMaidModelPlannerJson = (text = '') => {
  const raw = trim(text);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}

  const embedded = extractFirstJsonObject(raw);
  if (embedded) return embedded;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = trim(fenced?.[1] || '');
  if (!source) return null;
  try {
    return JSON.parse(source);
  } catch {
    return extractFirstJsonObject(source);
  }
};

const MAID_IMPORTED_CARD_CLASSIFICATION_SCHEMA = Object.freeze({
  type: 'object',
  required: ['entries', 'candidates', 'group'],
  additionalProperties: false,
  properties: {
    entries: {
      type: 'array',
      description: 'Exactly one classification for every supplied entryId.',
      items: {
        type: 'object',
        required: ['entryId', 'kind'],
        additionalProperties: false,
        properties: {
          entryId: { type: 'string' },
          kind: { enum: ['character', 'setting', 'format', 'rule', 'other'] },
        },
      },
    },
    candidates: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        required: ['entryId', 'name', 'confidence', 'reason'],
        additionalProperties: false,
        properties: {
          entryId: { type: 'string' },
          name: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reason: { type: 'string' },
        },
      },
    },
    group: {
      type: 'object',
      required: ['enabled', 'name', 'memberEntryIds'],
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        name: { type: 'string' },
        memberEntryIds: {
          type: 'array',
          maxItems: 20,
          items: { type: 'string' },
        },
      },
    },
  },
});

export const buildMaidImportedCardClassificationMessages = ({
  input = '',
  persona = {},
  worldbook = {},
  entries = [],
} = {}) => {
  const compactEntries = (Array.isArray(entries) ? entries : []).map((entry, index) => ({
    entryId: trim(entry?.id || entry?.entryId, `entry-${index + 1}`),
    title: trim(entry?.title || entry?.name || entry?.id, `entry-${index + 1}`),
    keys: list(entry?.keys).slice(0, 12),
    secondaryKeys: list(entry?.secondaryKeys).slice(0, 8),
    disabled: entry?.disabled === true,
    constant: entry?.constant === true,
    ...(trim(entry?.content) ? { contentExcerpt: trim(entry.content).slice(0, 1200) } : {}),
  }));
  const task = {
    request: trim(input),
    persona: {
      id: trim(persona?.id),
      name: trim(persona?.name || persona?.id),
    },
    worldbook: {
      id: trim(worldbook?.id),
      name: trim(worldbook?.name || worldbook?.id),
      entryCount: Math.max(0, Math.trunc(Number(worldbook?.entryCount) || compactEntries.length)),
    },
    entries: compactEntries,
    outputSchema: MAID_IMPORTED_CARD_CLASSIFICATION_SCHEMA,
  };
  return [
    {
      role: 'system',
      content: [
        '你是导入角色卡世界书的人物分类器，只做一次有界分类，不调用工具、不写入 APP。',
        '必须只输出一个 JSON 对象，禁止 Markdown 代码块、解释文字或额外字段。',
        '对输入中的每个 entryId 恰好输出一次 kind：character / setting / format / rule / other。',
        'candidates 只能引用被标为 character 的真实 entryId，需给显示名、0~1 置信度和简短理由；不得伪造 entryId。',
        '“主要人物”是精简建议，不是把所有人物条目全选。优先满足用户指定阵营/团队/范围；低置信度仍可列出，但必须如实降低 confidence。',
        'disabled 只表示世界书触发状态，不代表该条目不是人物，不能仅因此排除。',
        'group.memberEntryIds 只能引用 candidates；若用户不要求群聊则 enabled=false。',
        '输出必须满足任务中给出的 outputSchema；entries 数量必须与输入 entries 数量完全相同。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify(task),
    },
  ];
};

export const createMaidImportedCardClassifier = ({
  resolveRuntimeConfig = null,
  createClient = null,
  isConfigReady = () => false,
  onDebugSnapshot = null,
  logger = console,
} = {}) => async (payload = {}, context = {}) => {
  if (typeof resolveRuntimeConfig !== 'function') {
    throw new Error('maid imported-card classifier unavailable');
  }
  const runtime = await resolveRuntimeConfig({
    sessionId: trim(context?.sessionId),
    uiMode: trim(context?.uiMode),
    taskType: 'maid_imported_card_classifier',
    voiceCallId: trim(context?.voiceCallId),
  });
  const config = isPlainObject(runtime?.config) ? runtime.config : {};
  let client = runtime?.client || null;
  if (!client && typeof createClient === 'function' && isConfigReady(config)) {
    client = createClient(config);
  }
  if (!client || typeof client.chat !== 'function') {
    throw new Error(runtime?.reason || 'maid imported-card classifier API not configured');
  }

  const messages = buildMaidImportedCardClassificationMessages(payload);
  try {
    const responseText = await chatWithFallback(
      client,
      resolveFallbackClientForMessages(runtime, messages),
      messages,
      {
        temperature: 0,
        maxTokens: 10000,
        max_tokens: 10000,
        signal: context?.signal,
        maidGeneration: maidGenerationFor(runtime, config),
      },
      logger,
      null,
      typeof context?.onModelUsage === 'function' ? context.onModelUsage : null,
    );
    emitDebugSnapshot(onDebugSnapshot, {
      source: 'maid_imported_card_classifier',
      input: trim(payload?.input),
      messages,
      responseText,
    }, logger);
    const parsed = extractMaidModelPlannerJson(responseText);
    if (!isPlainObject(parsed)) {
      throw new Error('maid imported-card classifier returned invalid JSON');
    }
    return parsed;
  } catch (error) {
    logger?.warn?.('maid imported-card classifier failed', error);
    emitDebugSnapshot(onDebugSnapshot, {
      source: 'maid_imported_card_classifier',
      input: trim(payload?.input),
      messages,
      responseText: error?.message || 'maid imported-card classifier failed',
      error,
    }, logger);
    throw error;
  }
};

export const normalizeMaidModelPlan = (raw = {}, {
  features = listAppFeatures(),
  findFeature = findAppFeature,
  candidateMode = false,
  candidateSnapshotId = '',
} = {}) => {
  if (!isPlainObject(raw)) return unsupportedPlan('invalid_model_plan', '模型没有返回有效计划。');
  if (raw.ok === false) {
    return unsupportedPlan(trim(raw.reason, 'unsupported_intent'), truncate(raw.message || '这个请求还没有接入女仆工具。', 160));
  }
  const modelFeatures = getMaidModelFeatureContext(features).features;
  const featureId = trim(raw.featureId);
  const toolName = trim(raw.toolName);
  if (candidateMode) {
    const resolved = resolveCandidateCapabilitySelection({
      featureId,
      toolName,
      features: modelFeatures,
      allowFuzzy: true,
    });
    if (!resolved.ok) {
      const nearest = (resolved.nearestCandidates || []).map(item => item.id).filter(Boolean);
      const suffix = nearest.length ? `，最接近候选：${nearest.join('、')}` : '';
      const reason = resolved.reason === 'tool_not_allowed' ? 'tool_not_allowed' : 'feature_not_found';
      return unsupportedPlan(
        reason,
        `模型选择不在当前候选快照内（featureId=${featureId || '空'}，toolName=${toolName || '空'}${suffix}）。`,
        {
          candidateSnapshotId: trim(candidateSnapshotId),
          nearestCandidates: nearest,
          selectedCapabilityId: featureId,
          selectedToolName: toolName,
          candidateViolation: true,
        },
      );
    }
    const feature = resolved.feature;
    return {
      ok: true,
      toolName: resolved.toolName,
      args: isPlainObject(raw.args) ? clone(raw.args) : {},
      featureId: trim(feature.id),
      title: truncate(raw.title || feature.title || feature.id, 80),
      response: truncate(raw.response || '', 160),
      source: 'model_planner',
      candidateSnapshotId: trim(candidateSnapshotId),
      ...(resolved.correction ? { capabilityCorrection: resolved.correction } : {}),
    };
  }
  // 弱格式模型常把 featureId 和 toolName 混搭：工具归属唯一时按 toolName 纠偏 feature。
  const featuresByTool = toolName
    ? modelFeatures.filter(item => list(item?.tools).includes(toolName))
    : [];
  let capabilityCorrection = null;
  let feature = typeof findFeature === 'function' ? findFeature(featureId) : null;
  if (feature?.maidModelContext === 'awareness_only') feature = null;
  feature ||= modelFeatures.find(item => trim(item?.id) === featureId) || null;
  if (!feature) {
    if (featuresByTool.length === 1) {
      feature = featuresByTool[0];
      capabilityCorrection = {
        originalId: featureId,
        resolvedId: trim(feature.id),
        rule: 'unique_tool_owner',
        confidence: 1,
      };
    } else {
      return unsupportedPlan('feature_not_found', `模型选择了不存在的 APP 功能（featureId=${featureId || '空'}，toolName=${toolName || '空'}）。`);
    }
  }

  const allowedTools = new Set(list(feature.tools));
  if (!toolName || !allowedTools.has(toolName)) {
    if (toolName && featuresByTool.length === 1) {
      feature = featuresByTool[0];
      capabilityCorrection = {
        originalId: featureId,
        resolvedId: trim(feature.id),
        rule: 'unique_tool_owner',
        confidence: 1,
      };
    } else {
      return unsupportedPlan('tool_not_allowed', `模型选择的工具不在功能白名单内（featureId=${trim(feature.id)}，toolName=${toolName || '空'}，该功能可用：${list(feature.tools).join('、') || '无'}）。`);
    }
  }

  return {
    ok: true,
    toolName,
    args: isPlainObject(raw.args) ? clone(raw.args) : {},
    featureId: trim(feature.id),
    title: truncate(raw.title || feature.title || feature.id, 80),
    response: truncate(raw.response || '', 160),
    source: 'model_planner',
    ...(capabilityCorrection ? { capabilityCorrection } : {}),
  };
};

export const buildMaidModelReActMessages = ({
  input = '',
  context = {},
  conversationContext = null,
  features = listAppFeatures(),
  maidPrompt = DEFAULT_MAID_PROMPT,
  steps = [],
  transportMode = MAID_PROMPTED_JSON_MODE,
  featureIndex = null,
} = {}) => {
  const modelFeatureContext = getMaidModelFeatureContext(features);
  const providerFc = trim(transportMode).toLowerCase() === MAID_PROVIDER_FC_MODE;
  const featureCatalog = buildMaidFeatureCatalogPrompt({ features, featureIndex, includeSchemas: !providerFc });
  const prompt = getLocalizedMaidPrompt(trim(maidPrompt, DEFAULT_MAID_PROMPT));
  const memoryText = trim(conversationContext?.memoryText);
  const historyText = trim(conversationContext?.historyText);
  const imageAttachments = getMaidImageAttachmentsFromContext(context);
  const imageSummary = buildMaidImageAttachmentSummary(imageAttachments);
  const selectionBlock = buildMaidSelectionPromptBlock(context?.userSelection);
  const subAgentsBlock = buildMaidSubAgentsPromptBlock(context?.subAgents);
  const imageGenerationBlock = buildMaidImageGenerationContextPromptBlock(context?.imageGenerationContext);
  const runContinuationBlock = buildMaidRunContinuationPromptBlock(context?.runContinuation);
  // 步骤观察滚动窗口：早期步骤只留一行摘要，最近步骤保留完整观察——
  // 防止长任务里 steps 序列化超限截断导致模型看不到最新工具结果（观察失明）。
  const RECENT_STEP_WINDOW = 4;
  const stepList = Array.isArray(steps) ? steps : [];
  const olderSteps = stepList.slice(0, Math.max(0, stepList.length - RECENT_STEP_WINDOW));
  const recentSteps = stepList.slice(-RECENT_STEP_WINDOW);
  const sourceGroundingBlock = buildMaidSourceGroundingPromptBlock({
    input,
    steps: stepList,
  });
  const visualSpecBlock = buildMaidVisualSpecPromptBlock(context?.maidVisualSpecLedger);
  const olderText = olderSteps
    .map((step, i) => `${i + 1}. ${trim(step?.toolName)}:${trim(step?.status)} ${truncate(trim(step?.summary), 90)}`)
    .join('\n');
  const successfulReadLedger = buildMaidSuccessfulReadLedger(stepList);
  const stepsText = [
    olderText ? `更早步骤（仅摘要）：\n${olderText}` : '',
    `最近步骤与完整观察：\n${stringifyRecentStepsForPrompt(recentSteps, 12000) || '[]'}`,
  ].filter(Boolean).join('\n');
  // 会变的内容（本次候选的完整参数）放在用户消息开头，系统提示保持不变以命中服务商的提示词缓存
  const userText = [
    featureCatalog.detailText,
    `用户请求：${trim(input)}`,
    runContinuationBlock,
    sourceGroundingBlock,
    visualSpecBlock,
    selectionBlock,
    subAgentsBlock,
    imageSummary ? `用户附图：\n${imageSummary}` : '',
    imageGenerationBlock,
    `当前会话：${trim(context?.sessionId, '-')}`,
    `UI 模式：${trim(context?.uiMode, '-')}`,
    `当前页面：${trim(context?.activePage, '-')}`,
    `界面呈现意图：${trim(context?.presentationIntent?.mode, 'background')}`,
    buildMaidMemoryPromptBlock({ memoryText, historyText }),
    successfulReadLedger ? `成功读取账本：\n${successfulReadLedger}` : '',
    `已执行步骤与观察结果：\n${stepsText}`,
  ].filter(Boolean).join('\n');
  return [
    {
      role: 'system',
      content: [
        '你是这个 APP 内女仆助手的 ReAct 控制器。',
        modelFeatureContext.awareness,
        '',
        '## 输出协议',
        '你要在内部完成 Reason -> Act -> Observe 判断，但不要输出思考过程。',
        ...(providerFc ? [
          '本轮 API 已提供当前候选范围内的 APP 函数。仍需行动时必须调用且只调用一个业务函数。',
          '观察结果已足够回答、需要澄清或必须停止时，只调用 maid_planner_control，并在 message 中给出自然答复。',
          '不要输出函数参数、格式样例或额外解释文字；业务函数的执行前提示由 APP 本地生成。',
        ] : [
          '你只能输出严格 JSON，不能输出解释文字。',
          '如果已有观察结果足够回答用户，输出：{"ok":true,"action":"final","message":"给用户的自然回答"}',
          '如果还需要再调用一个工具，输出：{"ok":true,"action":"tool","toolName":"工具名","args":{},"featureId":"功能id","title":"短标题","response":"执行前短回复"}',
          '如果无法继续，输出：{"ok":false,"reason":"短原因","message":"给用户看的说明"}',
          '不要在 final message 中输出待执行的 JSON 或工具参数；如果还需要执行工具，必须输出 action:"tool" 的严格 JSON。',
        ]),
        '',
        '## 工具与参数规则',
        '每次最多选择一个工具；不要发明工具；只能使用 APP 功能目录中 feature 允许的 tools。',
        '工具失败时，先读取观察结果中的失败原因（reason/message/failureCode）再决定下一步，不要把失败一律当偶发问题直接重试：failureCode 为 user_aborted/safety_denied/write_intent_required（用户中止、取消、拒绝确认或原请求没有授权写入）时绝不自动重试，停下向用户说明并询问是否继续；invalid_args 时修正参数重试；服务或网络类失败才值得换方式再试一次。',
        '连续操作界面或对当前界面状态不确定时（如上一步涉及打开/切换/发送），先用 app.ui.inspect 查看当前实际状态再决定下一步，不要凭猜测行动。',
        'APP 界面可能以简体中文、繁体中文或英文显示；识别与操作元素时优先使用 inspect 返回的 semanticKey/ref，不要假定可见文案固定为某一种语言。',
        '作品资料世界书必须用 sourceLayer 区分 canon、user_original、creative_extension；canon 的 sourceRefs 只能引用 <maid_source_grounding> 中 relevant 的完整 URL。严格“不编造”任务不得省略资料层，也不得把创意扩写当 canon。',
        'media.generate_image 必须完整传 subject/subjectAliases/target/purpose/appearance/outfit/style/targetAspectRatio，并复用 <maid_visual_specs> 的冻结设计；生成附件只能写回相同 target 与 purpose。',
        'app.ui.inspect 拿到按钮 ref 后，如果用户要求点击，下一步使用 featureId=app.ui.click、toolName=ui.click_element 并传该 ref；不要改写 featureId，也不要用 todo 代替点击。',
        '最终回答只能陈述已执行工具步骤中真实完成的操作；用户要求的操作（如点击、切换、发送）如果没有对应的成功步骤，就不能说已完成——要么先用工具真正执行，要么如实说明你改用了什么方式（如“从页面统计直接读到了数字，没有切换过滤器”）。',
        '任务规划判据：todo 只用于跨 3 个及以上不同功能域、且包含写入、生成或较长处理链的复杂任务；多个结构化资源的只读比较不需要 todo，打开→检查→点击这类短界面序列也不要写清单。',
        '界面呈现原则：普通查询与操作默认在后台执行，不要主动打开面板、进入聊天室或切换页面；查询、查看、检查等词不等于要求打开界面。只有用户明确要求打开、进入、带他去看，或任务本身必须由用户在界面继续填写时才导航。',
        '批量任务即使用户要求展示，也只展示最终的主要结果，不要逐项打开重复或次要页面；带 open 参数的工具默认传 false，明确要求展示时才传 true。',
        '例外：chat.send_message 的 user 消息在 triggerReply:true 时会走正常回复链，当前实现必须进入目标聊天室并传 open:true；只有 triggerReply:false 的纯消息写入才能 open:false 后台追加。',
        '教我、一步步、引导等教学请求与普通展示不同；不要在普通后台任务中自行启动或模拟新手引导。',
        '一次成功读取已经返回用户要求的字段时，立即 final；不要为了“再确认”重复读取同一资源。多个只读资源尚未全部取得时，直接调用下一个具体读取工具。',
        '成功读取账本中出现相同工具与参数，表示该读取已经完成；账本已保留用户所需事实且其后没有写入时，禁止重复调用，直接处理下一个未完成目标或 final。',
        'maid.todo.write 只在清单状态实际变化时调用，不要在每一步前后机械更新。遇到 todo_unchanged 后禁止重试相同清单，立即执行当前 in_progress 或 pending 项的具体工具。',
        '写过 todo 的复杂任务要逐项确认完成状态；如果最近一次 maid.todo.write 已返回全部 completed，无需再读。只有清单状态不确定或用户询问进度时才用 maid.todo.read；只要仍有未完成项，就继续执行对应具体工具。',
        '如果清单上的某一项在 APP 功能目录里找不到任何能完成它的工具，不要卡住：用 maid.todo.write 把该项标记为 cancelled（或在内容后注明“无对应工具”），跳过它继续做下一项，并在最终汇报中如实说明该项做不了及原因。',
        '工具 args 必须是完整、具体、可直接执行的 JSON；不要使用 "__keep_existing"、"同上"、"省略"、"待补" 等占位值。需要旧内容时先调用读取工具。',
        '处理附图时，继续使用本次请求的 attachmentId 或 preparedImageId；不要把 base64 或图片 data URL 写进 args。',
        'ui.capture_region 成功返回 imageInjected:true 后，本轮最新选区截图已经作为图片输入附在当前消息中；请直接查看图片并回答，不要无理由重复截取同一区域。只能使用 <user_selection> 给出的区域ID，不能传坐标。',
        '',
        '## 安全原则',
        getLocalizedMaidOperationSafetyPrompt(),
        MAID_DELETE_PREVIEW_RULE,
        '如果用户只要求查询、查看、检查或确认，禁止调用 writes:true 的功能；权限确认不代表用户授权了原请求之外的写入。',
        '世界书写入必须默认追加或新建；不要使用 replace，除非用户明确要求覆盖，且 APP 会要求用户点击确认。',
        '修改现有世界书条目时，优先使用 worldbook.update_entries 按条目更新；长正文拆成多次小批量工具调用，每次只更新 1-3 个条目。',
        '如果每个世界书条目正文较长，优先每次只更新 1 个条目，后续继续调用工具处理下一条。',
        '',
        '## 验证与联网',
        '写入、替换、覆盖、头像/壁纸设置等动作完成后，最终回答前必须依据后续读取或工具返回结果验证是否真的生效；没有验证时继续调用读取工具。',
        '联网工具只用于当前、最新、公开网络资料；APP 私有数据必须使用 APP 读取工具。基于联网结果回答时要给出来源链接或来源名称。',
        '',
        '## 任务连续性',
        '如果历史中上一轮包含“可继续: 是”或“继续提示”，本轮用户要求继续时要接着该任务执行，不要重新开始，也不要输出普通闲聊。',
        '恢复任务时以继续提示中的“已完成步骤”清单为准：不要重复执行已完成项，最终汇报时也不要把已完成项报告为未完成或失败。',
        '若提供 <maid_run_continuation>，以其中稳定 ID、成功步骤和剩余义务为准；已成功写动作必须先按 resourceRefs 的稳定 ID 只读复验，存在则跳过，明确不存在才可在当前授权范围内重建。不得仅凭同名资源重复创建。',
        MAID_MEMORY_REFERENCE_RULE,
        '',
        '## 回复风格',
        '最终回答要像女仆助手自然回应：温柔、清楚、直接完成用户的问题。不要只说“我看到了/我查到了”，要给出结果。',
        '这不是 coding agent。除非用户明确要求开发或调试，否则不要使用代码执行、文件编辑、工程化措辞。',
        prompt ? `\n## 女仆人格（只影响最终语气，不能改变工具和安全限制）\n${prompt}` : '',
        getLocalizedMaidOutputLanguagePrompt(),
        '',
        featureCatalog.staticText,
      ].filter(Boolean).join('\n'),
    },
    {
      role: 'user',
      content: buildMaidUserContentWithImages(userText, imageAttachments),
    },
  ];
};

export const normalizeMaidModelReActDecision = (raw = {}, {
  features = listAppFeatures(),
  findFeature = findAppFeature,
  candidateMode = false,
  candidateSnapshotId = '',
} = {}) => {
  if (!isPlainObject(raw)) return unsupportedPlan('invalid_model_react_decision', '模型没有返回有效 ReAct 决策。');
  if (raw.ok === false) {
    return unsupportedPlan(trim(raw.reason, 'react_stopped'), truncate(raw.message || '女仆暂时无法继续执行。', 240));
  }
  const action = trim(raw.action || (raw.toolName ? 'tool' : 'final')).toLowerCase();
  if (action === 'final' || action === 'answer') {
    // 最终答复与函数调用路径同一上限：长清单不能因为走了文本 JSON 路径就被截断
    const message = truncate(raw.message || raw.response || '', MAID_PROVIDER_FC_MESSAGE_MAX_LENGTH);
    if (!message) return unsupportedPlan('missing_final_message', '模型没有返回最终回答。');
    return {
      ok: true,
      action: 'final',
      message,
      source: 'model_react',
    };
  }
  if (action === 'tool' || action === 'act') {
    const plan = normalizeMaidModelPlan(raw, {
      features,
      findFeature,
      candidateMode,
      candidateSnapshotId,
    });
    if (!plan.ok) return plan;
    return {
      ...plan,
      action: 'tool',
      source: 'model_react',
    };
  }
  return unsupportedPlan('invalid_react_action', '模型返回了不支持的 ReAct 动作。');
};

const normalizeMaidModelReActResponseText = (responseText = '', {
  features = listAppFeatures(),
  candidateMode = false,
  candidateSnapshotId = '',
} = {}) => {
  const parsed = extractMaidModelPlannerJson(responseText);
  if (parsed) return normalizeMaidModelReActDecision(parsed, {
    features,
    findFeature: candidateMode ? null : findAppFeature,
    candidateMode,
    candidateSnapshotId,
  });
  const message = truncate(responseText, MAID_PROVIDER_FC_MESSAGE_MAX_LENGTH);
  if (!message) return normalizeMaidModelReActDecision(null, {
    features,
    findFeature: candidateMode ? null : findAppFeature,
    candidateMode,
    candidateSnapshotId,
  });
  if (/"toolName"\s*:|["']action["']\s*:\s*["']tool["']|["']featureId["']\s*:/i.test(message)) {
    return unsupportedPlan('invalid_model_react_decision', '模型返回了不完整的工具决策。');
  }
  return {
    ok: true,
    action: 'final',
    message,
    source: 'model_react_text_fallback',
    parseWarning: 'invalid_json',
  };
};

const resolveCapabilityDecisionFeatures = (context = {}, fallbackFeatures = []) => {
  const snapshot = context?.capabilitySnapshot;
  return Array.isArray(snapshot?.promptFeatures) ? snapshot.promptFeatures : fallbackFeatures;
};

const featureListUsesImageGeneration = (features = []) => (
  (Array.isArray(features) ? features : [])
    .some(feature => list(feature?.tools).includes('media.generate_image'))
);

const shouldInjectImageGenerationContext = (context = {}, promptFeatures = []) => {
  const snapshotCandidates = context?.capabilitySnapshot?.candidateFeatures;
  const relevantFeatures = Array.isArray(snapshotCandidates) ? snapshotCandidates : promptFeatures;
  if (featureListUsesImageGeneration(relevantFeatures)) return true;
  return (Array.isArray(context?.maidReactSteps) ? context.maidReactSteps : [])
    .some(step => trim(step?.toolName) === 'media.generate_image');
};

const resolveImageGenerationContext = async ({
  context = {},
  promptFeatures = [],
  getImageGenerationContext = null,
  logger = console,
} = {}) => {
  if (!shouldInjectImageGenerationContext(context, promptFeatures)) return null;
  if (typeof getImageGenerationContext !== 'function') {
    return normalizeMaidImageGenerationContext(context?.imageGenerationContext);
  }
  try {
    return normalizeMaidImageGenerationContext(await getImageGenerationContext());
  } catch (error) {
    logger?.debug?.('maid image generation context unavailable', error);
    return null;
  }
};

const annotateCapabilitySnapshotModel = (context = {}, runtime = {}, config = {}) => {
  const snapshot = context?.capabilitySnapshot;
  if (!snapshot || typeof snapshot !== 'object') return;
  snapshot.cohort = {
    ...(isPlainObject(snapshot.cohort) ? snapshot.cohort : {}),
    profileId: trim(runtime?.profileId),
    provider: trim(config?.provider),
    model: trim(config?.model),
  };
};

const annotateCapabilitySnapshotResolvedModel = (context = {}, runtime = {}, primaryConfig = {}, source = 'primary') => {
  const fallback = source === 'fallback';
  annotateCapabilitySnapshotModel(
    context,
    { profileId: fallback ? runtime?.fallbackProfileId : runtime?.profileId },
    fallback && isPlainObject(runtime?.fallbackConfig) ? runtime.fallbackConfig : primaryConfig,
  );
};

const resolveMaidProviderFcExperimentStatus = (getStatus = null, context = {}) => {
  if (typeof getStatus !== 'function') return { enabled: false, thinkingEnabled: false };
  try {
    const status = getStatus(context);
    return isPlainObject(status)
      ? { enabled: status.enabled === true, thinkingEnabled: status.thinkingEnabled === true }
      : { enabled: false, thinkingEnabled: false };
  } catch {
    return { enabled: false, thinkingEnabled: false };
  }
};

const buildMaidPlannerTransport = ({
  experimentStatus = null,
  effectiveMode = MAID_PROMPTED_JSON_MODE,
  fallbackReason = '',
  runtime = null,
  config = null,
  providerSource = 'primary',
  capabilitySnapshot = null,
  toolCallCount = 0,
  providerDiagnostics = null,
} = {}) => {
  const primaryConfig = isPlainObject(config) ? config : {};
  const fallbackConfig = isPlainObject(runtime?.fallbackConfig) ? runtime.fallbackConfig : {};
  const diagnostics = isPlainObject(providerDiagnostics) ? providerDiagnostics : {};
  const hasEffectiveThinking = Object.prototype.hasOwnProperty.call(diagnostics, 'thinkingEnabled');
  return {
    requestedMode: experimentStatus?.enabled === true ? MAID_PROVIDER_FC_MODE : MAID_PROMPTED_JSON_MODE,
    effectiveMode,
    fallbackReason: trim(fallbackReason),
    providerSource: trim(providerSource, 'primary'),
    primaryProvider: trim(primaryConfig.provider),
    primaryModel: trim(primaryConfig.model),
    fallbackProvider: trim(fallbackConfig.provider),
    fallbackModel: trim(fallbackConfig.model),
    thinkingRequested: Object.prototype.hasOwnProperty.call(diagnostics, 'thinkingRequested')
      ? diagnostics.thinkingRequested === true
      : experimentStatus?.thinkingEnabled === true,
    thinkingEnabled: hasEffectiveThinking
      ? diagnostics.thinkingEnabled === true
      : experimentStatus?.thinkingEnabled === true,
    thinkingOverrideReason: trim(diagnostics.thinkingOverrideReason),
    providerFamily: trim(diagnostics.providerFamily),
    providerEndpoint: trim(diagnostics.providerEndpoint),
    candidateSnapshotId: trim(capabilitySnapshot?.id),
    toolCallCount: Math.max(0, Math.trunc(Number(toolCallCount) || 0)),
  };
};

const runMaidProviderFcPlanner = async ({
  client = null,
  messages = [],
  input = '',
  context = {},
  runtime = null,
  config = null,
  decisionFeatures = [],
  capabilitySnapshot = null,
  experimentStatus = null,
  phase = 'planner',
  maxTokens = 8000,
  onDebugSnapshot = null,
  logger = console,
} = {}) => {
  const attempt = await runMaidProviderFcAttempt({
    client,
    messages,
    config,
    capabilitySnapshot,
    experimentStatus,
    phase,
    signal: context?.signal,
    maxTokens,
    generationSettings: runtime?.generationSettings || null,
    onModelUsage: typeof context?.onModelUsage === 'function' ? context.onModelUsage : null,
  });
  if (!attempt.ok) return { ok: false, attempt };

  let decision = null;
  if (attempt.kind === 'control') {
    decision = {
      ok: true,
      action: 'final',
      message: truncate(attempt.control?.message, MAID_PROVIDER_FC_MESSAGE_MAX_LENGTH),
      source: 'maid_provider_fc',
      providerFcControl: trim(attempt.control?.action, 'no_tool'),
      ...(trim(attempt.control?.reason) ? { reason: trim(attempt.control.reason) } : {}),
    };
  } else if (attempt.kind === 'tool') {
    const rawPlan = {
      ok: true,
      action: 'tool',
      toolName: attempt.selection?.toolName,
      args: attempt.selection?.args,
      featureId: attempt.selection?.featureId,
      title: attempt.selection?.title,
      response: attempt.selection?.response,
    };
    decision = trim(phase).toLowerCase() === 'react'
      ? normalizeMaidModelReActDecision(rawPlan, {
          features: decisionFeatures,
          findFeature: null,
          candidateMode: true,
          candidateSnapshotId: capabilitySnapshot?.id || '',
        })
      : normalizeMaidModelPlan(rawPlan, {
          features: decisionFeatures,
          findFeature: null,
          candidateMode: true,
          candidateSnapshotId: capabilitySnapshot?.id || '',
        });
    if (decision?.ok) {
      decision = {
        ...decision,
        source: 'maid_provider_fc',
        ...(trim(phase).toLowerCase() === 'react' ? { action: 'tool' } : {}),
      };
    }
  }

  if (!decision?.ok) {
    return {
      ok: false,
      attempt: {
        ...attempt,
        ok: false,
        reason: decision?.reason || 'provider_fc_plan_invalid',
      },
    };
  }
  const plannerTransport = buildMaidPlannerTransport({
    experimentStatus,
    effectiveMode: MAID_PROVIDER_FC_MODE,
    runtime,
    config,
    providerSource: 'primary',
    capabilitySnapshot,
    toolCallCount: attempt.toolCallCount,
    providerDiagnostics: attempt.diagnostics,
  });
  const completed = { ...decision, plannerTransport };
  emitDebugSnapshot(onDebugSnapshot, {
    source: trim(phase).toLowerCase() === 'react' ? 'maid_provider_fc_react' : 'maid_provider_fc_planner',
    input: trim(input),
    messages,
    responseText: JSON.stringify({
      mode: MAID_PROVIDER_FC_MODE,
      kind: attempt.kind,
      toolName: trim(completed.toolName),
      featureId: trim(completed.featureId),
      control: trim(completed.providerFcControl),
      argumentKeys: isPlainObject(completed.args) ? Object.keys(completed.args) : [],
    }),
  }, logger);
  return { ok: true, decision: completed, attempt };
};

export const createMaidModelBackedPlanner = ({
  resolveRuntimeConfig = null,
  createClient = null,
  isConfigReady = () => false,
  features = listAppFeatures(),
  getConversationContext = null,
  getImageGenerationContext = null,
  getProviderFcExperimentStatus = null,
  getGlobalSemanticPromptLibrary = null,
  onContextInjected = null,
  onDebugSnapshot = null,
  logger = console,
} = {}) => async (input = '', context = {}) => {
  if (typeof resolveRuntimeConfig !== 'function') {
    return unsupportedPlan('maid_model_planner_unavailable', '女仆需要先通过 AI 判断要调用的工具。');
  }

  let runtime = null;
  try {
    runtime = await resolveRuntimeConfig({
      sessionId: trim(context?.sessionId),
      uiMode: trim(context?.uiMode),
      taskType: 'maid_assistant',
      voiceCallId: trim(context?.voiceCallId),
    });
  } catch (error) {
    logger?.debug?.('maid model planner runtime unavailable', error);
    return unsupportedPlan('maid_model_planner_unavailable', '女仆需要先通过 AI 判断要调用的工具，请确认 API 配置可用。');
  }

  let client = runtime?.client || null;
  const config = isPlainObject(runtime?.config) ? runtime.config : {};
  annotateCapabilitySnapshotModel(context, runtime, config);
  if (!client && typeof createClient === 'function' && isConfigReady(config)) {
    try {
      client = createClient(config);
    } catch (error) {
      logger?.debug?.('maid model planner client creation failed', error);
      return unsupportedPlan('maid_client_error', '女仆暂时无法建立 API 连接。');
    }
  }
  if (!client || typeof client.chat !== 'function') {
    return unsupportedPlan(runtime?.reason || 'maid_api_not_configured', '请先为女仆绑定可用的 API 配置。');
  }

  try {
    const promptFeatures = resolveCapabilityDecisionFeatures(context, features);
    const decisionFeatures = getMaidModelFeatureContext(promptFeatures).features;
    const capabilitySnapshot = context?.capabilitySnapshot || null;
    // 目录详情按检索排名取前几项（即使未进入候选模式也按相关度排序），全部功能只作索引
    const catalogFeatures = Array.isArray(capabilitySnapshot?.candidateFeatures) && capabilitySnapshot.candidateFeatures.length
      ? capabilitySnapshot.candidateFeatures
      : promptFeatures;
    const imageGenerationContext = await resolveImageGenerationContext({
      context,
      promptFeatures,
      getImageGenerationContext,
      logger,
    });
    const conversationContext = resolveMaidConversationContextSnapshot({
      getConversationContext,
      input,
      context,
      taskType: 'maid_assistant',
    });
    const plannerContext = {
      ...context,
      subAgents: runtime?.subAgents || [],
      ...(imageGenerationContext ? { imageGenerationContext } : {}),
    };
    const globalSemanticPromptPlan = resolveGlobalSemanticPromptPlan(
      typeof getGlobalSemanticPromptLibrary === 'function'
        ? getGlobalSemanticPromptLibrary()
        : null,
      {
        scope: 'maid',
        taskType: 'maid_assistant',
        rootPlanner: true,
        user: trim(context?.userName, '用户'),
        char: trim(context?.maidName, '女仆'),
        now: new Date(),
      },
    );
    const providerFcExperimentStatus = resolveMaidProviderFcExperimentStatus(
      getProviderFcExperimentStatus,
      context,
    );
    onContextInjected?.({
      source: 'maid_model_planner',
      input: trim(input),
      conversationContext,
    });
    let providerFcFallbackReason = '';
    let providerFcAttemptDiagnostics = null;
    if (providerFcExperimentStatus.enabled) {
      const providerFcMessages = buildMaidModelPlannerMessages({
        input,
        context: plannerContext,
        conversationContext,
        features: catalogFeatures,
        featureIndex: features,
        maidPrompt: runtime?.maidPrompt || runtime?.personaPrompt,
        transportMode: MAID_PROVIDER_FC_MODE,
        globalSemanticPromptPlan,
      });
      const providerFc = await runMaidProviderFcPlanner({
        client,
        messages: providerFcMessages,
        input,
        context,
        runtime,
        config,
        decisionFeatures,
        capabilitySnapshot,
        experimentStatus: providerFcExperimentStatus,
        phase: 'planner',
        maxTokens: 8000,
        onDebugSnapshot,
        logger,
      });
      if (providerFc.ok) return providerFc.decision;
      providerFcFallbackReason = trim(providerFc.attempt?.reason, 'provider_fc_unavailable');
      providerFcAttemptDiagnostics = providerFc.attempt?.diagnostics || null;
    }
    const messages = buildMaidModelPlannerMessages({
      input,
      context: plannerContext,
      conversationContext,
      features: catalogFeatures,
        featureIndex: features,
      maidPrompt: runtime?.maidPrompt || runtime?.personaPrompt,
      globalSemanticPromptPlan,
    });
    let providerSource = 'primary';
    const responseText = await chatWithFallback(
      client,
      resolveFallbackClientForMessages(runtime, messages),
      messages,
      {
        temperature: 0,
        maxTokens: 8000,
        max_tokens: 8000,
        signal: context?.signal,
        maidGeneration: maidGenerationFor(runtime, config),
      },
      logger,
      (source) => {
        providerSource = source;
        annotateCapabilitySnapshotResolvedModel(context, runtime, config, source);
      },
      typeof context?.onModelUsage === 'function' ? context.onModelUsage : null,
    );
    emitDebugSnapshot(onDebugSnapshot, {
      source: 'maid_model_planner',
      input: trim(input),
      messages,
      responseText,
    }, logger);
    const parsed = extractMaidModelPlannerJson(responseText);
    const modelPlan = normalizeMaidModelPlan(parsed, {
      features: decisionFeatures,
      findFeature: capabilitySnapshot?.useCandidates ? null : findAppFeature,
      candidateMode: capabilitySnapshot?.useCandidates === true,
      candidateSnapshotId: capabilitySnapshot?.id || '',
    });
    if (!providerFcExperimentStatus.enabled) return modelPlan;
    return {
      ...modelPlan,
      plannerTransport: buildMaidPlannerTransport({
        experimentStatus: providerFcExperimentStatus,
        effectiveMode: MAID_PROMPTED_JSON_MODE,
        fallbackReason: providerFcFallbackReason,
        runtime,
        config,
        providerSource,
        capabilitySnapshot,
        providerDiagnostics: providerFcAttemptDiagnostics,
      }),
    };
  } catch (error) {
    if (isMaidUserAbort(error, context?.signal)) throw error;
    logger?.warn?.('maid model planner failed', error);
    emitDebugSnapshot(onDebugSnapshot, {
      source: 'maid_model_planner',
      input: trim(input),
      messages: buildMaidModelPlannerMessages({
        input,
        context,
        conversationContext: resolveMaidConversationContextSnapshot({
          getConversationContext,
          input,
          context,
          taskType: 'maid_assistant',
        }),
        features: resolveCapabilityDecisionFeatures(context, features),
        maidPrompt: runtime?.maidPrompt || runtime?.personaPrompt,
      }),
      responseText: error?.message || 'maid model planner failed',
      error,
    }, logger);
    return unsupportedPlan(error?.message || 'maid_model_planner_failed', '女仆暂时无法判断要调用哪个工具。');
  }
};

export const createMaidModelBackedReActPlanner = ({
  resolveRuntimeConfig = null,
  createClient = null,
  isConfigReady = () => false,
  features = listAppFeatures(),
  getConversationContext = null,
  getImageGenerationContext = null,
  getProviderFcExperimentStatus = null,
  onContextInjected = null,
  onDebugSnapshot = null,
  logger = console,
} = {}) => async (input = '', context = {}) => {
  if (typeof resolveRuntimeConfig !== 'function') {
    return unsupportedPlan('maid_react_unavailable', '女仆需要先通过 AI 继续判断下一步。');
  }

  let runtime = null;
  try {
    runtime = await resolveRuntimeConfig({
      sessionId: trim(context?.sessionId),
      uiMode: trim(context?.uiMode),
      taskType: 'maid_react',
      voiceCallId: trim(context?.voiceCallId),
    });
  } catch (error) {
    logger?.debug?.('maid react runtime unavailable', error);
    return unsupportedPlan('maid_react_unavailable', '女仆暂时无法继续判断下一步。');
  }

  let client = runtime?.client || null;
  const config = isPlainObject(runtime?.config) ? runtime.config : {};
  annotateCapabilitySnapshotModel(context, runtime, config);
  if (!client && typeof createClient === 'function' && isConfigReady(config)) {
    try {
      client = createClient(config);
    } catch (error) {
      logger?.debug?.('maid react client creation failed', error);
      return unsupportedPlan('maid_client_error', '女仆暂时无法建立 API 连接。');
    }
  }
  if (!client || typeof client.chat !== 'function') {
    return unsupportedPlan(runtime?.reason || 'maid_api_not_configured', '请先为女仆绑定可用的 API 配置。');
  }

  try {
    const promptFeatures = resolveCapabilityDecisionFeatures(context, features);
    const decisionFeatures = getMaidModelFeatureContext(promptFeatures).features;
    const capabilitySnapshot = context?.capabilitySnapshot || null;
    // 目录详情按检索排名取前几项（即使未进入候选模式也按相关度排序），全部功能只作索引
    const catalogFeatures = Array.isArray(capabilitySnapshot?.candidateFeatures) && capabilitySnapshot.candidateFeatures.length
      ? capabilitySnapshot.candidateFeatures
      : promptFeatures;
    const imageGenerationContext = await resolveImageGenerationContext({
      context,
      promptFeatures,
      getImageGenerationContext,
      logger,
    });
    const conversationContext = resolveMaidConversationContextSnapshot({
      getConversationContext,
      input,
      context,
      taskType: 'maid_react',
    });
    const steps = Array.isArray(context?.maidReactSteps) ? context.maidReactSteps : [];
    const plannerContext = {
      ...context,
      subAgents: runtime?.subAgents || [],
      ...(imageGenerationContext ? { imageGenerationContext } : {}),
    };
    const providerFcExperimentStatus = resolveMaidProviderFcExperimentStatus(
      getProviderFcExperimentStatus,
      context,
    );
    onContextInjected?.({
      source: 'maid_model_react',
      input: trim(input),
      conversationContext,
    });
    let providerFcFallbackReason = '';
    let providerFcAttemptDiagnostics = null;
    if (providerFcExperimentStatus.enabled) {
      const providerFcMessages = buildMaidModelReActMessages({
        input,
        context: plannerContext,
        conversationContext,
        features: catalogFeatures,
        featureIndex: features,
        maidPrompt: runtime?.maidPrompt || runtime?.personaPrompt,
        steps,
        transportMode: MAID_PROVIDER_FC_MODE,
      });
      const providerFc = await runMaidProviderFcPlanner({
        client,
        messages: providerFcMessages,
        input,
        context,
        runtime,
        config,
        decisionFeatures,
        capabilitySnapshot,
        experimentStatus: providerFcExperimentStatus,
        phase: 'react',
        maxTokens: 12000,
        onDebugSnapshot,
        logger,
      });
      if (providerFc.ok) return providerFc.decision;
      providerFcFallbackReason = trim(providerFc.attempt?.reason, 'provider_fc_unavailable');
      providerFcAttemptDiagnostics = providerFc.attempt?.diagnostics || null;
    }
    const messages = buildMaidModelReActMessages({
      input,
      context: plannerContext,
      conversationContext,
      features: catalogFeatures,
        featureIndex: features,
      maidPrompt: runtime?.maidPrompt || runtime?.personaPrompt,
      steps,
    });
    let providerSource = 'primary';
    const responseText = await chatWithFallback(
      client,
      resolveFallbackClientForMessages(runtime, messages),
      messages,
      {
        temperature: 0,
        maxTokens: 12000,
        max_tokens: 12000,
        signal: context?.signal,
        maidGeneration: maidGenerationFor(runtime, config),
      },
      logger,
      (source) => {
        providerSource = source;
        annotateCapabilitySnapshotResolvedModel(context, runtime, config, source);
      },
      typeof context?.onModelUsage === 'function' ? context.onModelUsage : null,
    );
    emitDebugSnapshot(onDebugSnapshot, {
      source: 'maid_model_react',
      input: trim(input),
      messages,
      responseText,
    }, logger);
    const decision = normalizeMaidModelReActResponseText(responseText, {
      features: decisionFeatures,
      candidateMode: capabilitySnapshot?.useCandidates === true,
      candidateSnapshotId: capabilitySnapshot?.id || '',
    });
    if (!providerFcExperimentStatus.enabled) return decision;
    return {
      ...decision,
      plannerTransport: buildMaidPlannerTransport({
        experimentStatus: providerFcExperimentStatus,
        effectiveMode: MAID_PROMPTED_JSON_MODE,
        fallbackReason: providerFcFallbackReason,
        runtime,
        config,
        providerSource,
        capabilitySnapshot,
        providerDiagnostics: providerFcAttemptDiagnostics,
      }),
    };
  } catch (error) {
    if (isMaidUserAbort(error, context?.signal)) throw error;
    logger?.warn?.('maid react planner failed', error);
    emitDebugSnapshot(onDebugSnapshot, {
      source: 'maid_model_react',
      input: trim(input),
      messages: buildMaidModelReActMessages({
        input,
        context,
        conversationContext: resolveMaidConversationContextSnapshot({
          getConversationContext,
          input,
          context,
          taskType: 'maid_react',
        }),
        features: resolveCapabilityDecisionFeatures(context, features),
        maidPrompt: runtime?.maidPrompt || runtime?.personaPrompt,
        steps: Array.isArray(context?.maidReactSteps) ? context.maidReactSteps : [],
      }),
      responseText: error?.message || 'maid react planner failed',
      error,
    }, logger);
    return unsupportedPlan(error?.message || 'maid_react_failed', '女仆暂时无法继续判断下一步。');
  }
};
