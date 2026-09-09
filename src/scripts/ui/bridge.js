/**
 * UI 桥接层 - 连接原有 UI 代码和新的 API 层
 */

import { sanitizeRequestPreviewUrl } from '../api/request-params.js';
import { LLMClient } from '../api/client.js';
import { captureRequestContext } from '../api/request-context.js';
import { canInitClient } from '../api/client-config-utils.js';
import {
  applyDeepSeekPrefillToStream,
  hasProviderToolRequestOptions,
  mergeDeepSeekPrefillResponse,
  resolveDeepSeekPhonePrefillPlan,
} from '../api/deepseek-phone-prefill-utils.js';
import { buildReasoningRequestOptions, getReasoningSamplerPolicy } from '../api/model-capabilities.js';
import { isReasoningStreamEvent } from '../api/native-reasoning.js';
import {
  buildWebSearchRequestPlan,
  mergeWebSources,
} from '../api/web-search-runtime.js';
import { resolveBuiltinPhoneFormatReminderPlan } from '../utils/builtin-phone-format-contract.js';
import {
  normalizePhoneFormatPromptDepth,
  normalizePhoneFormatPromptPosition,
} from '../utils/phone-format-prompt-placement.js';
import {
  isDeepSeekApiRequest,
  shouldUseDeepSeekReasonerCompatibility,
} from '../api/providers/deepseek-compat.js';
import {
  BUILTIN_PHONE_FORMAT_CHAT_PROMPT_SPECS,
  BUILTIN_PHONE_FORMAT_WORLDBOOK,
  BUILTIN_PHONE_FORMAT_WORLDBOOK_ID,
  CURRENT_PHONE_IMAGE_MESSAGE_RULES,
  getBuiltinPhoneFormatPromptSeed,
  LEGACY_PHONE_IMAGE_MESSAGE_RULES,
} from '../storage/builtin-worldbooks.js';
import { ChatStorage } from '../storage/chat.js';
import { ConfigManager } from '../storage/config.js';
import { PresetStore } from '../storage/preset-store.js';
import { RegexStore, regex_placement } from '../storage/regex-store.js';
import { ScriptStore } from '../storage/script-store.js';
import { WorldInfoStore, convertSTWorld } from '../storage/worldinfo.js';
import { resolveWorldSessionBindingMutation } from '../storage/world-session-binding-utils.js';
import {
  cloneWorldInfoValue,
  WorldInfoConcurrencyCoordinator,
  WORLDINFO_REVISION_CONFLICT,
} from '../storage/worldinfo-concurrency.js';
import { stickerPackStore } from '../storage/sticker-pack-store.js';
import { makeScopedKey, normalizeScopeId } from '../storage/store-scope.js';
import { appSettings } from '../storage/app-settings.js';
import { getLocalizedPromptText, getPromptLocale } from '../i18n/prompt-locale.js';
import { chatFcLocalCapabilityStore } from '../storage/chat-fc-local-capability-store.js';
import { chatStructuredRouteEvidenceStore } from '../storage/chat-structured-route-evidence-store.js';
import { renderTemplateMessages, templateSettings } from '../plugins/template-engine.js';
import { getChatUI } from './chat-ui-runtime-utils.js';
import { recordDebugTraceEvent } from './debug-ui-registry-utils.js';
import {
  WORLDBOOK_IMPORT_CONFLICT_CODE,
  WORLDBOOK_IMPORT_DECISIONS,
  buildWorldbookImportPlan,
} from './worldbook-import-conflict-utils.js';
import {
  buildAutoImagePromptInstruction,
  shouldAllowAutoImagePromptByRateLimit,
} from './chat/auto-image-prompt-utils.js';
import {
  limitMomentWorldEntriesByBudget,
  resolveMomentSessionWorldBudgetTokens,
  resolveMomentWorldStrongSources,
} from './chat/moment-world-resolver-utils.js';
import {
  buildContactProfileWeakTriggerPrompt,
  resolveContactProfileWeakTriggers,
} from '../memory/contact-profile-utils.js';
import {
  PROMPT_SEGMENT_ANCHORS,
  normalizePromptSegmentAnchor,
  sortPromptSegments,
  splitDepthPromptMessagesForLatest,
  toPromptSegment,
} from './chat/prompt-segment-plan-utils.js';
import {
  applyPromptPostProcessing,
  buildPendingUserTextWithScenarioReminder,
  normalizePromptPostProcessingMode,
  resolveOpenAIPresetFormatReminderState,
} from './chat/prompt-context-utils.js';
import {
  buildPromptTraceFromRequest,
} from './chat/context-lineage-graph-utils.js';
import {
  buildCompletedResponseDiagnostics,
  buildFirstTokenResponseDiagnostics,
  mergeResponseDiagnosticsIntoUsage,
} from './chat/request-response-diagnostics-utils.js';
import {
  createGenerationProviderCallDiagnosticsTracker,
  isMeaningfulTextStreamDelta,
} from './chat/generation-provider-call-diagnostics-utils.js';
import {
  normalizeRequestConfigUiMode,
  resolveRequestConfigProfileId,
} from './chat/request-config-profile-utils.js';
import {
  isBridgeAbortError,
  resolveBridgeCancellationReason,
  shouldTreatBridgeStreamErrorAsCancellation,
} from './bridge-cancel-utils.js';
import { buildProviderToolBridgeLoopPlan } from '../agent/provider-tool-bridge-loop-plan.js';
import {
  buildProviderFcRequestOptionsForLocalDiagnostics,
  buildProviderFcRequestPlan,
  resolveChatStructuredThinkingPreference,
  resolveChatProviderFcRelease,
  sanitizeProviderFcInheritedRequestOptions,
} from '../agent/provider-fc-transport.js';
import {
  CHAT_STRUCTURED_ROUTE_MODES,
  classifyChatStructuredAttemptFailure,
  getChatStructuredEvidenceKey,
  resolveChatStructuredRoute,
} from '../agent/chat-structured-route-evidence.js';
import { createChatStructuredEvidenceCommitRuntime } from '../agent/chat-structured-evidence-commit-runtime.js';
import {
  GLOBAL_SEMANTIC_PROMPT_ANCHORS,
  buildGlobalSemanticPromptInjectionAudit,
  buildGlobalSemanticPromptExtraBlocks,
  resolveGlobalSemanticPromptPlan,
} from '../agent/global-semantic-prompt-library.js';
import {
  buildChatStructuredRequestEvidenceIdentity,
  resolveChatStructuredHardBoundary,
  resolveChatStructuredTextTransport,
} from '../agent/chat-structured-route-request.js';
import { buildProviderToolRequestSchema } from '../agent/provider-tool-request-schema.js';
import { createWebSearchGenerationClient } from './chat/web-search-generation-client.js';
import {
  preparePrivateChatProviderFcRoute,
  runPrivateChatProviderFcAttempt,
} from './chat/private-chat-provider-fc.js';
import {
  preparePhoneBatchProviderFcRoute,
  runPhoneBatchProviderFcAttempt,
} from './chat/phone-batch-provider-fc.js';
import {
  derivePhoneReplyJsonFormatCapabilities,
  preparePhoneReplyJsonRoute,
  runPhoneReplyJsonAttempt,
} from './chat/phone-reply-json-terminal.js';
import { readOpenRouterModelCapabilities } from '../api/openrouter-model-capabilities.js';
import { buildChatStructuredContractSummary } from './chat/chat-structured-contract-summary.js';
import {
  assembleLegacyTextRequest,
  restoreDeferredLegacyTextMessages,
} from './chat/chat-semantic-snapshot-utils.js';
import {
  dispatchRuntimeHookLifecycleEvent,
  runRuntimeHookLifecycleEvent,
} from './chat/hook-lifecycle-trace-utils.js';
import { createSillyTavernSlashCompat } from './chat/sillytavern-slash-compat.js';
import {
  buildTemplateInjectRegex as buildRegexFromTag,
  parseTemplateInjectTags,
} from './template-inject-tag-utils.js';
import {
  buildMemoryBridgeYamlLines,
  buildMemoryTablePlan,
  estimateTokens,
  getMemoryBridgeTablePromptLabel,
  isSummaryTableId,
  formatMemoryRowText,
  normalizeMemoryCell,
  normalizeMemoryUpdateMode,
  normalizeTokenMode,
  parseMemoryPromptPositions,
} from '../memory/memory-prompt-utils.js';
import { buildMemoryEditGuide } from '../memory/memory-edit-guide.js';
import {
  formatMemoryPromptText,
  getMemoryPromptListSeparator,
  joinMemoryPromptLabel,
} from '../memory/memory-prompt-locale.js';
import {
  DEFAULT_CONSERVATIVE_COEFFICIENT,
  tokenCalibrationStore,
} from '../memory/token-calibration-utils.js';
import {
  buildMemoryPlanAudit,
  buildRequestInjectionAudit,
  estimatePromptMessagesTokens,
  promptMessagesContainNonTextContent,
} from '../memory/memory-injection-audit-utils.js';
import { isOutlineTableId } from '../memory/outline-section-utils.js';
import {
  reflowUnusedRecallToRecent,
  resolveMemoryBudgetEnvelope,
} from '../memory/memory-budget-allocator-utils.js';
import {
  buildMemoryPromptRowLayers,
  buildSegmentedMemoryTablePlan,
  estimateMemorySegmentDemands,
} from '../memory/memory-segment-plan-utils.js';
import { buildMemoryKeywordRecallPlan } from '../memory/memory-keyword-recall-utils.js';
import {
  buildWorldbookDowngradeSuggestion,
  buildWorldbookDowngradeSuggestions,
} from '../memory/worldbook-downgrade-suggestion-utils.js';
import { buildMemoryCoverageLine } from '../memory/memory-coverage-utils.js';
import {
  resolveInputTokenBudget,
  resolveRecentHistoryQuota,
} from '../memory/input-token-budget-utils.js';
import { resolveMemoryRowOrderKey } from '../memory/memory-row-order.js';
import {
  getMemoryContextType,
  getSummaryTableIdsForContext,
  isRpSessionId,
  resolveMemorySessionMode,
  tableMatchesMemoryContext,
} from '../memory/memory-context-utils.js';
import { resolveVisibleSessionWorldIds } from './world-session-visibility-utils.js';
import {
  limitHistoryByTokenBudget,
  mapHistoryMessagesToTurns,
  resolveCoverageProtectedHistoryIndexes,
} from './chat/llm-history-utils.js';
import {
  getChatToMomentsBridgeTableIds,
  getChatToRpBridgeSourceMeta,
  getChatToRpBridgeTableIds,
  getMomentsToChatBridgeTableIds,
  getRpToMomentsBridgeTableIds,
  getRpToChatBridgeTableIds,
  normalizeBridgeLimit,
  resolveChatToMomentsBridgeTableSettings,
  resolveChatToRpBridgeTableSettings,
  resolveMomentsToChatBridgeTableSettings,
  resolveRpToMomentsBridgeTableSettings,
  resolveRpToChatBridgeTableSettings,
} from '../memory/memory-bridge-utils.js';
import { logger } from '../utils/logger.js';
import { MacroEngine } from '../utils/macro-engine.js';
import { emitDebugLog } from '../utils/debug-log.js';
import { listMediaAssets } from '../utils/media-assets.js';
import { isRetryableError, retryWithBackoff } from '../utils/retry.js';
import { safeInvoke } from '../utils/tauri.js';
import {
  analyzeWorldEntryActivation,
  normalizeWorldEntryKeys,
  normalizeWorldEntrySecondaryKeys,
  prepareWorldEntries,
} from '../utils/world-entry-activation.js';
import {
  buildMacroVariableContext,
  buildVariableContext,
} from '../variables/variable-path-utils.js';
import {
  collectConditionDefineSpecs,
  createDefaultPromptClause,
  evaluateConditionTree,
  explainConditionTree,
  isTrivialConditionTree,
  normalizeConditionTree,
  normalizeWorldPromptMode,
  parseTypedValue,
  shouldUseWorldPromptBlocks,
} from '../variables/world-condition-core.js';

const isTauriInvokeUnavailableError = error => (
  /tauri invoke not available/i.test(String(error?.message || error || ''))
);

const WORLDINFO_REVISION_META = Symbol.for('tauri-chat-app.worldinfo-revision');
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const attachWorldInfoRevisionMeta = (data, snapshot = {}) => {
  if (!data || typeof data !== 'object') return data;
  try {
    Object.defineProperty(data, WORLDINFO_REVISION_META, {
      configurable: true,
      enumerable: true,
      value: Object.freeze({
        revision: snapshot.revision,
        generation: snapshot.generation,
        exists: snapshot.exists,
      }),
    });
  } catch {}
  return data;
};

const getWorldInfoWriteExpectation = (data, options = {}) => {
  const explicit = options && typeof options === 'object' ? options : {};
  const implicit = data && typeof data === 'object' ? data[WORLDINFO_REVISION_META] : null;
  return {
    ...(implicit && typeof implicit === 'object' ? {
      expectedRevision: implicit.revision,
      expectedGeneration: implicit.generation,
      expectedExists: implicit.exists,
    } : {}),
    ...(hasOwn(explicit, 'expectedRevision') ? { expectedRevision: explicit.expectedRevision } : {}),
    ...(hasOwn(explicit, 'expectedGeneration') ? { expectedGeneration: explicit.expectedGeneration } : {}),
    ...(hasOwn(explicit, 'expectedExists') ? { expectedExists: explicit.expectedExists } : {}),
  };
};

const makeCancelledError = (reason = 'user') => {
  const e = new Error('cancelled');
  e.name = 'AbortError';
  e.cancelled = true;
  e.reason = String(reason || 'user');
  return e;
};

const isRecoverableNativeStreamTailError = (error, fullResponse = '') => {
  const text = String(fullResponse || '');
  if (!text.trim()) return false;
  const message = String(error?.message || error || '').trim().toLowerCase();
  if (!message) return false;
  return (
    message.includes('native http_stream_request failed') &&
    message.includes('error decoding response body')
  );
};

const truthy = v => {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
};

const normalizeWorldVariableDefineStrategy = (raw, fallback = 'legacy_eager') => {
  const normalize = (value) => {
    const token = String(value || '').trim().toLowerCase();
    if (!token) return '';
    if (token === 'legacy_eager' || token === 'eager' || token === 'request_start') return 'legacy_eager';
    if (token === 'first_hit' || token === 'on_hit' || token === 'on_match') return 'first_hit';
    if (token === 'off' || token === 'edit_time' || token === 'manual') return 'off';
    return '';
  };
  return normalize(raw) || normalize(fallback) || 'legacy_eager';
};

const normalizeWorldInsertionStrategy = (raw, fallback = 'role_first') => {
  const normalize = (value) => {
    const token = String(value || '').trim().toLowerCase();
    if (token === 'role_first' || token === 'global_first' || token === 'even') return token;
    return '';
  };
  return normalize(raw) || normalize(fallback) || 'role_first';
};

const parseWorldNonNegativeInt = (value, fallback = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.max(0, Math.trunc(Number(fallback) || 0));
  return Math.max(0, Math.trunc(n));
};

const buildWorldActivationSettings = (worldSettings = {}) => ({
  globalCaseSensitive: worldSettings.caseSensitive === true,
  globalMatchWholeWords: worldSettings.matchWholeWords === true,
  globalRecursiveScan: worldSettings.recursiveScan !== false,
  globalUseGroupScoring: worldSettings.useGroupScoring === true,
  minActivations: parseWorldNonNegativeInt(worldSettings.minActivations, 0),
  maxDepthSetting: parseWorldNonNegativeInt(worldSettings.maxDepth, 0),
  maxRecursionStepsSetting: parseWorldNonNegativeInt(worldSettings.maxRecursionSteps, 0),
  variableDefineStrategy: normalizeWorldVariableDefineStrategy(
    worldSettings.variableDefineStrategy,
    'legacy_eager',
  ),
});

const renderStTemplate = (template, vars) => {
  let out = String(template || '');
  const varsLower = (() => {
    try {
      const m = Object.create(null);
      for (const [k, v] of Object.entries(vars || {})) {
        if (!k) continue;
        m[String(k).toLowerCase()] = v;
      }
      return m;
    } catch {
      return Object.create(null);
    }
  })();
  // {{#if var}}...{{else}}...{{/if}} (SillyTavern preset format)
  const ifRe = /{{#if\s+([a-zA-Z0-9_]+)\s*}}([\s\S]*?)({{else}}([\s\S]*?))?{{\/if}}/g;
  // Loop to handle multiple blocks (no nesting expected in presets)
  for (let i = 0; i < 100; i++) {
    const next = out.replace(ifRe, (_m, key, ifTrue, _elseBlock, ifFalse) => {
      const v =
        vars && Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : varsLower[String(key).toLowerCase()];
      return truthy(v) ? ifTrue : ifFalse || '';
    });
    if (next === out) break;
    out = next;
  }
  // Replace variables {{var}} and {{trim}}
  out = out.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_m, key) => {
    if (key === 'trim') return '';
    const hasDirect = vars && Object.prototype.hasOwnProperty.call(vars, key);
    const v = hasDirect ? vars[key] : varsLower[String(key).toLowerCase()];
    // Preserve unknown keys for MacroEngine (e.g. {{USER}}, {{lastUserMessage}}, {{getvar::...}})
    if (v === null || v === undefined) return `{{${key}}}`;
    return String(v);
  });
  // Cleanup any leftover trim token and trim surrounding whitespace
  out = out.replace(/{{\s*trim\s*}}/g, '');
  return out.trim();
};

const DEFAULT_OPENAI_IMPERSONATION_PROMPT =
  '[Write your next reply from the point of view of {{user}}, using the chat history so far as a guideline for the writing style of {{user}}. Don\'t write as {{char}} or system. Don\'t describe actions of {{char}}.]';
const DEFAULT_OPENAI_MAIN_PROMPT =
  "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.";

const normalizeReplyTarget = (value, fallback = 'character') => {
  const token = String(value || '').trim().toLowerCase();
  if (token === 'user') return 'user';
  if (token === 'character' || token === 'char' || token === 'assistant') return 'character';
  return String(fallback || '').trim().toLowerCase() === 'user' ? 'user' : 'character';
};

const resolvePresetReplyTarget = (preset, uiMode = 'chat', override = '') => {
  const mode = String(uiMode || '').trim().toLowerCase() === 'rp' ? 'rp' : 'chat';
  const fallback = mode === 'rp' ? 'user' : 'character';
  const overrideTarget = normalizeReplyTarget(override, '');
  if (String(override || '').trim()) return overrideTarget;
  const key = mode === 'rp' ? 'response_target_rp' : 'response_target_chat';
  return normalizeReplyTarget(preset?.[key], fallback);
};

const normalizeBridgePresetUiMode = (value = '', { sessionId = '', taskType = '' } = {}) => {
  return normalizeRequestConfigUiMode(value, { sessionId, taskType });
};

const withSpeakerPrefix = (content, speaker) => {
  const text = String(content ?? '');
  const name = String(speaker || '').trim();
  if (!text.trim() || !name) return text;
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  // Avoid double prefix
  if (firstLine.startsWith(`${name}:`) || firstLine.startsWith(`${name}：`)) return text;
  return `${name}: ${text}`;
};

const normalizeHistoryLineBreaks = (content, role, { preserveParagraphs = false } = {}) => {
  if (role !== 'assistant') return content;
  const text = String(content ?? '');
  if (preserveParagraphs) {
    let out = text
      .replace(/&lt;br\s*\/?&gt;/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
    // Some regex replacements emit literal "\n". Decode them only on prompt history path.
    if (!out.includes('\n') && out.includes('\\n') && !out.includes('```')) {
      out = out.replace(/\\n/g, '\n');
    }
    out = out.replace(/\n{4,}/g, '\n\n\n');
    return out;
  }
  if (!text.includes('\n') && !text.includes('\r')) return text;
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '<br>');
};

const SUMMARY_REQUEST_NOTICE = [
  '每次输出结束后，**紧跟着**以一句话概括本次互动的摘要，确保<details><summary>摘要</summary>',
  '<内容>',
  '</details>标签顺序正确，摘要**纯中文输出**，不得夹杂其它语言',
  '[summary_format]',
  '摘要格式示例：',
  '',
  '<details><summary>摘要</summary>',
  '',
  '用一句话概括本条回复的内容，禁止不必要的总结和升华',
].join('\n');

const formatExactTime = (ts) => {
  const t = Number(ts || 0);
  if (!Number.isFinite(t) || t <= 0) return '';
  try {
    return new Date(t).toLocaleString();
  } catch {
    return '';
  }
};

const buildTimeContextText = () => {
  const now = new Date();
  const locale = getPromptLocale();
  const date = now.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const weekday = now.toLocaleDateString(locale, { weekday: 'long' });
  const time = now.toLocaleTimeString(locale, { hour12: false, hour: '2-digit', minute: '2-digit' });
  const hour = now.getHours();
  const periodKey = hour < 5 ? 'early_morning' : hour < 12 ? 'morning' : hour < 14 ? 'noon' : hour < 18 ? 'afternoon' : hour < 22 ? 'evening' : 'late_night';
  const period = getLocalizedPromptText(`time_context.period.${periodKey}`);
  const month = now.getMonth() + 1;
  const seasonKey = (month === 12 || month <= 2) ? 'winter' : month <= 5 ? 'spring' : month <= 8 ? 'summer' : 'autumn';
  const season = getLocalizedPromptText(`time_context.season.${seasonKey}`);
  return getLocalizedPromptText('time_context.template')
    .replaceAll('{date}', date)
    .replaceAll('{weekday}', weekday)
    .replaceAll('{time}', time)
    .replaceAll('{period}', period)
    .replaceAll('{season}', season);
};

const PROMPT_CACHE_DEBUG_PREVIEW_CHARS = 72;
const PROMPT_CACHE_DEBUG_PREFIX_CHAR_BUDGET = 12000;

const hashPromptCacheDebugText = (value = '') => {
  const input = String(value || '');
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const stringifyPromptCacheDebugContent = (content) => {
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        if (part.type === 'text') return String(part.text || '');
        if (part.type === 'image_url') return '[image_url]';
        if (part.type === 'input_audio') return '[input_audio]';
        return part.type ? `[${String(part.type)}]` : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content ?? '');
};

const normalizePromptCacheDebugText = (value = '') =>
  String(value || '').replace(/\s+/g, ' ').trim();

const buildPromptCacheDebugSnapshot = (messages = []) => {
  const items = [];
  let totalChars = 0;
  let prefixChars = 0;
  let prefixSource = '';
  const list = Array.isArray(messages) ? messages : [];
  list.forEach((msg, index) => {
    const role = String(msg?.role || 'system').trim().toLowerCase() || 'system';
    const name = String(msg?.name || '').trim();
    const text = normalizePromptCacheDebugText(stringifyPromptCacheDebugContent(msg?.content));
    const len = text.length;
    const hash = hashPromptCacheDebugText(text);
    const preview = text.slice(0, PROMPT_CACHE_DEBUG_PREVIEW_CHARS);
    items.push({ index, role, name, len, hash, preview });
    totalChars += len;
    if (prefixChars < PROMPT_CACHE_DEBUG_PREFIX_CHAR_BUDGET) {
      const remaining = PROMPT_CACHE_DEBUG_PREFIX_CHAR_BUDGET - prefixChars;
      const chunk = text.slice(0, remaining);
      prefixSource += `#${index}:${role}:${name}:${chunk}\n`;
      prefixChars += chunk.length;
    }
  });
  return {
    messageCount: items.length,
    totalChars,
    prefixHash: hashPromptCacheDebugText(prefixSource),
    items,
  };
};

const comparePromptCacheDebugSnapshot = (prev, next) => {
  const prevItems = Array.isArray(prev?.items) ? prev.items : [];
  const nextItems = Array.isArray(next?.items) ? next.items : [];
  const max = Math.max(prevItems.length, nextItems.length);
  let stablePrefixChars = 0;
  for (let i = 0; i < max; i += 1) {
    const left = prevItems[i] || null;
    const right = nextItems[i] || null;
    const same = Boolean(
      left &&
      right &&
      left.role === right.role &&
      left.name === right.name &&
      left.len === right.len &&
      left.hash === right.hash
    );
    if (!same) {
      return {
        identical: false,
        firstDiffIndex: i,
        stablePrefixMessages: i,
        stablePrefixChars,
        prev: left,
        next: right,
      };
    }
    stablePrefixChars += Number(left?.len || 0);
  }
  return {
    identical: true,
    firstDiffIndex: -1,
    stablePrefixMessages: prevItems.length,
    stablePrefixChars,
    prev: null,
    next: null,
  };
};

const formatSince = (ts) => {
  const t = Number(ts || 0);
  if (!Number.isFinite(t) || t <= 0) return '';
  const delta = Math.max(0, Date.now() - t);
  const sec = Math.floor(delta / 1000);
  const relative = (value, unit) => {
    try {
      return new Intl.RelativeTimeFormat(getPromptLocale(), { numeric: 'always' }).format(-value, unit);
    } catch {
      return '';
    }
  };
  if (sec < 60) return relative(sec, 'second') || `${sec}秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return relative(min, 'minute') || `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return relative(hr, 'hour') || `${hr}小时前`;
  const day = Math.floor(hr / 24);
  return relative(day, 'day') || `${day}天前`;
};

const formatSinceInParens = (ts) => {
  const raw = formatSince(ts);
  if (!raw) return '';
  if (getPromptLocale() !== 'zh-CN' && getPromptLocale() !== 'zh-TW') return raw;
  return `距今${raw.replace(/前$/, '')}`;
};

const DEFAULT_MEMORY_BUDGET = {
  maxRows: 1000,
  maxTokens: 100000,
  safetyRatio: 1,
};

class AppBridge {
  constructor() {
    this.config = new ConfigManager();
    this.chatStorage = new ChatStorage();
    this.worldStore = new WorldInfoStore();
    this.worldInfoConcurrency = new WorldInfoConcurrencyCoordinator();
    this.presets = new PresetStore();
    this.regex = new RegexStore();
    this.scriptStore = new ScriptStore();
    this.client = null;
    this.initialized = false;
    this.currentCharacterId = 'default';
    this.currentWorldId = null;
    this.currentWorldIds = [];
    this.scopeId = '';
    this.globalWorldIds = this.loadGlobalWorldIds();
    this.globalWorldId = this.globalWorldIds[0] || null;
    this.worldGlobalSettings = this.loadWorldGlobalSettings();
    this.activeSessionId = 'default';
    this.worldSessionMap = this.loadWorldSessionMap();
    this.currentWorldIds = this.normalizeWorldIds(this.worldSessionMap[this.activeSessionId]);
    this.currentWorldId = this.currentWorldIds[0] || null;
    this.isGenerating = false;
    this.previewBuildPromise = null;
    this.abortController = null;
    this.abortReason = '';
    this.activeNativeRequestId = '';
    this.activeGenerationToken = 0;
    this.activeInputBudgetPlan = null;
    this.activeTokenEstimateMode = { mode: 'rough', coefficient: 1 };
    this.chatStore = null; // Injected
    this.macroEngine = null; // Initialized on setChatStore
    this.contactsStore = null; // Injected
    this.momentSummaryStore = null; // Injected
    this.memoryTableStore = null; // Injected
    this.memoryTemplateStore = null; // Injected
    this.contactProfileStore = null; // Injected
    this.chatUI = null; // Injected
    this.pluginRuntime = null; // Injected
    this.scriptRuntime = null; // Injected
    this.webSearchToolRuntime = null; // Injected read-only web.search/web.research runtime
    this.contextBuilder = null; // Injected (from UI)
    this.roleWorldResolver = null; // Injected (from UI)
    this.worldLifecycleHandler = null; // Injected (from UI)
    this.lastMemoryPlan = null;
    this.lastGenerationUsage = null;
    this.lastGenerationSources = null;
    this.lastMemoryUpdateBySession = {};
    this.lastWorldBudgetWarningAt = 0;
    this.lastWorldInjectionDebug = null;
    this.lastDeepSeekFormatDebug = null;
    this.lastPhoneFormatTransportPlan = null;
    this.chatStructuredEvidenceCommitRuntime = createChatStructuredEvidenceCommitRuntime({
      store: chatStructuredRouteEvidenceStore,
    });
    this.lastPromptCacheDebugBySession = new Map();
    this.worldBootstrapScheduled = false;
    this.worldBootstrapCompleted = false;
    this._worldBootstrapPromise = null;
    this.hydrateWorldSessionMap();
    this.hydrateGlobalWorldId();
    this.hydrateWorldGlobalSettings();
  }

  setChatStore(store) {
    this.chatStore = store;
    this.macroEngine = new MacroEngine(store);
  }

  getChatStore() {
    return this.chatStore || null;
  }

  setChatUI(ui) {
    this.chatUI = ui;
  }

  getChatUI() {
    return this.chatUI || null;
  }

  getCurrentCharacterId() {
    return this.currentCharacterId || '';
  }

  setPluginRuntime(runtime) {
    this.pluginRuntime = runtime || null;
  }

  getPluginRuntime() {
    return this.pluginRuntime || null;
  }

  setScriptRuntime(runtime) {
    this.scriptRuntime = runtime || null;
  }

  setWebSearchToolRuntime(runtime) {
    this.webSearchToolRuntime = runtime && typeof runtime === 'object' ? runtime : null;
  }

  getWebSearchToolRuntime() {
    return this.webSearchToolRuntime || null;
  }

  getScriptStore() {
    return this.scriptStore || null;
  }

  getScriptRuntime() {
    return this.scriptRuntime || null;
  }

  restartScriptWorker(reason = '') {
    return this.scriptRuntime?.restartWorker?.(reason);
  }

  allowScriptOnce(sessionId, scriptIds = []) {
    return this.scriptRuntime?.allowOnce?.(sessionId, scriptIds);
  }

  syncScripts(payload = {}) {
    return this.scriptRuntime?.syncScripts?.(payload);
  }

  dispatchScriptEvent(eventName, payload = {}, options = {}) {
    return this.scriptRuntime?.dispatchEvent?.(eventName, payload, options);
  }

  getPresetStore() {
    return this.presets || null;
  }

  setContactsStore(store) {
    this.contactsStore = store;
  }

  setMomentSummaryStore(store) {
    this.momentSummaryStore = store;
  }

  setMemoryTableStore(store) {
    this.memoryTableStore = store;
  }

  setMemoryTemplateStore(store) {
    this.memoryTemplateStore = store;
  }

  setContactProfileStore(store) {
    this.contactProfileStore = store;
  }

  getMemoryTableStore() {
    return this.memoryTableStore || null;
  }

  getMemoryTemplateStore() {
    return this.memoryTemplateStore || null;
  }

  getContactProfileStore() {
    return this.contactProfileStore || null;
  }

  getContactProfileSettings() {
    return this.contactProfileStore?.getSettings?.() || null;
  }

  updateContactProfileSettings(patch = {}) {
    return this.contactProfileStore?.updateSettings?.(patch) || null;
  }

  listContactProfiles() {
    return this.contactProfileStore?.listProfiles?.() || [];
  }

  getContactProfile(contactId = '') {
    return this.contactProfileStore?.getProfile?.(contactId) || null;
  }

  upsertContactProfile(profile = {}) {
    return this.contactProfileStore?.upsertProfile?.(profile) || null;
  }

  deleteContactProfile(contactId = '') {
    return this.contactProfileStore?.deleteProfile?.(contactId) || false;
  }

  listContactProfilePendingUpdates() {
    return this.contactProfileStore?.listPendingUpdates?.() || [];
  }

  approveContactProfilePendingUpdate(request = {}) {
    if (typeof this.contactProfileStore?.approvePendingUpdate === 'function') {
      return this.contactProfileStore.approvePendingUpdate(request);
    }
    const id = String(typeof request === 'string' ? request : request?.id || '').trim();
    if (!id) return { ok: false, reason: 'missing_id' };
    const pending = (this.contactProfileStore?.listPendingUpdates?.() || [])
      .find(item => String(item?.id || '').trim() === id);
    if (!pending?.profile) return { ok: false, reason: 'missing_pending_update' };
    const saved = this.contactProfileStore?.upsertProfile?.(pending.profile) || null;
    if (saved) this.contactProfileStore?.clearPendingUpdate?.(id);
    return {
      ok: Boolean(saved),
      contactId: String(saved?.contactId || pending?.contactId || '').trim(),
    };
  }

  denyContactProfilePendingUpdate(request = {}) {
    const id = String(typeof request === 'string' ? request : request?.id || '').trim();
    if (!id) return { ok: false, reason: 'missing_id' };
    return {
      ok: Boolean(this.contactProfileStore?.clearPendingUpdate?.(id)),
    };
  }

  setContextBuilder(fn) {
    this.contextBuilder = typeof fn === 'function' ? fn : null;
  }

  setRoleWorldResolver(fn) {
    this.roleWorldResolver = typeof fn === 'function' ? fn : null;
    this.syncWorldRegexBindings?.();
  }

  setWorldLifecycleHandler(fn) {
    this.worldLifecycleHandler = typeof fn === 'function' ? fn : null;
  }

  getRoleWorldBindings(sessionId = this.activeSessionId, options = {}) {
    if (typeof this.roleWorldResolver !== 'function') return [];
    const sid = String(sessionId || this.activeSessionId || '').trim();
    try {
      const list = this.roleWorldResolver(sid, options || {});
      if (!Array.isArray(list)) return [];
      return list
        .map((item) => {
          const worldId = String(item?.worldId || '').trim();
          return {
            personaId: String(item?.personaId || '').trim(),
            personaName: String(item?.personaName || '').trim() || '未命名角色',
            worldId,
            enabled: Boolean(worldId) && item?.enabled !== false,
            hasWorld: Boolean(worldId),
            isActive: item?.isActive === true,
          };
        })
        .filter((item) => item.personaId || item.worldId);
    } catch (err) {
      logger.debug('role world resolve failed', err);
      return [];
    }
  }

  getRoleWorldIds(sessionId = this.activeSessionId, options = {}) {
    const seen = new Set();
    const out = [];
    this.getRoleWorldBindings(sessionId, options).forEach((item) => {
      const worldId = String(item?.worldId || '').trim();
      if (!worldId || item?.enabled === false || seen.has(worldId) || worldId === BUILTIN_PHONE_FORMAT_WORLDBOOK_ID) return;
      seen.add(worldId);
      out.push(worldId);
    });
    return out;
  }

  getResolvedWorldState(sessionId = this.activeSessionId, options = {}) {
    const sid = String(sessionId || this.activeSessionId || 'default').trim() || 'default';
    const contact = this.contactsStore?.getContact?.(sid) || null;
    const uiModeRaw = String(options?.uiMode || '').trim().toLowerCase();
    const uiMode = uiModeRaw === 'rp' || sid.startsWith('rp:') ? 'rp' : 'chat';
    const isGroupChat = options?.isGroupChat === undefined
      ? (Boolean(contact?.isGroup) || sid.startsWith('group:'))
      : Boolean(options.isGroupChat);
    const groupMemberIds = Array.isArray(options?.groupMemberIds)
      ? options.groupMemberIds.map(item => String(item || '').trim()).filter(Boolean)
      : (isGroupChat && Array.isArray(contact?.members) ? contact.members.map(item => String(item || '').trim()).filter(Boolean) : []);
    const normalizeVisibleIds = (value) => this.normalizeWorldIds(value).filter((id) => id !== BUILTIN_PHONE_FORMAT_WORLDBOOK_ID);
    const globalWorldIds = normalizeVisibleIds(
      Array.isArray(this.globalWorldIds) ? this.globalWorldIds : this.globalWorldId,
    );
    const roleWorldIds = normalizeVisibleIds(this.getRoleWorldIds(sid, { ...(options || {}), uiMode, isGroupChat, groupMemberIds }));
    const sessionWorldIds = resolveVisibleSessionWorldIds({
      uiMode,
      sessionId: sid,
      isGroupChat,
      groupMemberIds,
      worldSessionMap: this.worldSessionMap,
      normalizeWorldIds: normalizeVisibleIds,
    });
    const worldIds = [];
    const pushUnique = (value) => {
      const worldId = String(value || '').trim();
      if (!worldId || worldId === BUILTIN_PHONE_FORMAT_WORLDBOOK_ID || worldIds.includes(worldId)) return;
      worldIds.push(worldId);
    };
    globalWorldIds.forEach(pushUnique);
    roleWorldIds.forEach(pushUnique);
    sessionWorldIds.forEach(pushUnique);
    return {
      sessionId: sid,
      uiMode,
      isGroupChat,
      groupMemberIds,
      globalWorldId: globalWorldIds[0] || '',
      globalWorldIds,
      roleWorldIds,
      sessionWorldIds,
      worldIds,
    };
  }

  async ensureWorldsForContext(context = {}) {
    if (this.worldStore?.ready) await this.worldStore.ready;
    const isMomentCommentTask = String(context?.task?.type || '').trim().toLowerCase() === 'moment_comment';
    const sessionId = String(
      (isMomentCommentTask ? context?.task?.targetSessionId : '')
      || context?.session?.id
      || this.activeSessionId
      || 'default',
    ).trim() || 'default';
    const groupMemberIds = isMomentCommentTask
      ? []
      : (Array.isArray(context?.group?.members) ? context.group.members : []);
    const resolved = this.getResolvedWorldState(sessionId, {
      uiMode: isMomentCommentTask ? 'chat' : context?.meta?.uiMode,
      isGroupChat: isMomentCommentTask ? false : context?.session?.isGroup,
      groupMemberIds,
    });
    const ids = isMomentCommentTask
      ? [...resolved.globalWorldIds, ...resolved.roleWorldIds]
      : resolved.worldIds;
    await this.worldStore?.ensureLoadedMany?.(ids, { includeRefs: true });
    return ids;
  }

  emitWorldInfoChanged(detail = {}) {
    const resolved = this.getResolvedWorldState(this.activeSessionId);
    window.dispatchEvent(new CustomEvent('worldinfo-changed', {
      detail: {
        worldId: this.currentWorldId,
        worldIds: this.currentWorldIds,
        globalWorldId: this.globalWorldId,
        globalWorldIds: this.getGlobalWorldIds(),
        roleWorldIds: resolved.roleWorldIds,
        resolvedWorldIds: resolved.worldIds,
        ...(detail || {}),
      },
    }));
  }

  processTextMacros(text, extraContext = {}) {
    if (!this.macroEngine) return text || '';
    const sessionId = String(extraContext?.sessionId || this.activeSessionId || '').trim();
    const ctx = {
      sessionId: this.activeSessionId,
      ...extraContext,
      variableRuntimeEnabled: this.isVariableRuntimeEnabled?.(sessionId) !== false,
    };
    return this.macroEngine.process(text, ctx);
  }

  emitPromptCacheDebug(sessionId, messages, { provider = '', model = '', stream = false, requestId = '' } = {}) {
    const sid = String(sessionId || this.activeSessionId || 'default').trim() || 'default';
    const snapshot = buildPromptCacheDebugSnapshot(messages);
    const prev = this.lastPromptCacheDebugBySession.get(sid) || null;
    const diff = comparePromptCacheDebugSnapshot(prev, snapshot);
    const mode = prev ? (diff.identical ? 'unchanged' : 'changed') : 'baseline';
    emitDebugLog({
      source: 'prompt-cache',
      type: 'info',
      message:
        `session=${sid} provider=${String(provider || '').trim() || '-'} model=${String(model || '').trim() || '-'} ` +
        `stream=${stream ? 1 : 0} requestId=${String(requestId || '').trim() || '-'} msgs=${snapshot.messageCount} ` +
        `chars=${snapshot.totalChars} prefixHash=${snapshot.prefixHash} mode=${mode}` +
        (prev ? ` stablePrefixMsgs=${diff.stablePrefixMessages} stablePrefixChars=${diff.stablePrefixChars}` : ''),
    });
    if (prev && !diff.identical) {
      const prevItem = diff.prev
        ? `${diff.prev.role}[len=${diff.prev.len},hash=${diff.prev.hash}] ${diff.prev.preview}`
        : '(none)';
      const nextItem = diff.next
        ? `${diff.next.role}[len=${diff.next.len},hash=${diff.next.hash}] ${diff.next.preview}`
        : '(none)';
      emitDebugLog({
        source: 'prompt-cache',
        type: 'warn',
        message: `firstDiffIndex=${diff.firstDiffIndex} prev=${prevItem} | next=${nextItem}`,
      });
    }
    this.lastPromptCacheDebugBySession.set(sid, snapshot);
    return snapshot;
  }

  cancelCurrentGeneration(reason = 'user') {
    const abortReason = String(reason || 'user');
    this.abortReason = abortReason;
    const controller = this.abortController;
    const requestId = String(this.activeNativeRequestId || '').trim();
    this.isGenerating = false;
    this.abortController = null;
    this.activeNativeRequestId = '';
    this.activeGenerationToken = 0;
    try {
      if (controller && !controller.signal.aborted) {
        controller.abort();
      }
    } catch {}
    if (requestId) {
      safeInvoke('http_abort_request', { requestId }).catch(() => {});
    }
  }

  async getDefaultMemoryTemplateRecord() {
    if (!this.memoryTemplateStore || typeof this.memoryTemplateStore.getTemplates !== 'function') return null;
    const list = await this.memoryTemplateStore.getTemplates({ is_default: true });
    if (Array.isArray(list) && list.length) return list[0];
    const fallback = await this.memoryTemplateStore.getTemplates({ id: 'default-v1' });
    if (Array.isArray(fallback) && fallback.length) return fallback[0];
    return null;
  }

  async buildMemoryPromptPlan(context = {}) {
    const memoryMode = String(context?.meta?.memoryStorageMode || '').trim().toLowerCase();
    const autoExtract = Boolean(context?.meta?.memoryAutoExtract);
    const updateMode = normalizeMemoryUpdateMode(context?.meta?.memoryUpdateMode, 'full');
    const globalSettings = appSettings.get();
    const configuredMaxRows = Math.trunc(Number(globalSettings.memoryMaxRows));
    const configuredMaxTokens = Math.trunc(Number(globalSettings.memoryMaxTokens));
    const memoryBudget = {
      maxRows: Number.isFinite(configuredMaxRows) && configuredMaxRows > 0
        ? configuredMaxRows
        : DEFAULT_MEMORY_BUDGET.maxRows,
      maxTokens: Number.isFinite(configuredMaxTokens) && configuredMaxTokens > 0
        ? configuredMaxTokens
        : DEFAULT_MEMORY_BUDGET.maxTokens,
      safetyRatio: DEFAULT_MEMORY_BUDGET.safetyRatio,
    };
    const disabledPlan = (reason) => ({
      enabled: false,
      reason,
      items: [],
      truncated: [],
      tokenTotal: 0,
      tokenBudget: memoryBudget.maxTokens,
      tokenBudgetSafety: Math.floor(memoryBudget.maxTokens * memoryBudget.safetyRatio),
      tokenBudgetData: Math.floor(memoryBudget.maxTokens * memoryBudget.safetyRatio),
      overheadTokens: 0,
      maxRows: memoryBudget.maxRows,
      position: 'before_latest_user',
      injectDepth: 0,
      promptText: '',
      dataPromptText: '',
      guidePromptText: '',
      guidePosition: 'before_latest_user',
      guideInjectDepth: 0,
      tableData: '',
      dynamicProfileDebug: null,
      updateMode,
      templateId: '',
      templateName: '',
      targetId: '',
      targetName: '',
      scope: '',
      autoExtract,
      tableOrder: [],
      rowIndexMap: {},
      tableTargets: [],
      audit: { version: 1, segments: [], usedTokens: 0 },
    });

    if (memoryMode !== 'table') return disabledPlan('memory_mode');
    if (!this.memoryTableStore || !this.memoryTemplateStore) return disabledPlan('missing_store');

    let record = null;
    try {
      record = await this.getDefaultMemoryTemplateRecord();
    } catch {
      record = null;
    }
    if (!record) return disabledPlan('missing_template');

    const toTemplate = this.memoryTemplateStore.toTemplateDefinition?.bind(this.memoryTemplateStore);
    const baseSchema = record?.schema && typeof record.schema === 'object' ? record.schema : {};
    const template = toTemplate ? toTemplate(record) : { ...baseSchema, injection: record?.injection ?? null };
    const templateId = String(template?.meta?.id || record?.id || '').trim();
    const templateName = String(template?.meta?.name || record?.name || '').trim();
    if (!templateId) return disabledPlan('missing_template_id');

    const sessionId = String(context?.meta?.memorySessionId || context?.session?.id || this.activeSessionId || '').trim();
    if (!sessionId) return disabledPlan('missing_session');

    const isGroup = Boolean(context?.session?.isGroup) || sessionId.startsWith('group:');
    const contextType = getMemoryContextType({
      sessionId,
      isGroup,
      contextType: context?.meta?.memoryContextType,
    });
    const sessionMode = resolveMemorySessionMode({
      uiMode: context?.meta?.uiMode,
      sessionId,
      contextType,
    });
    const scope = contextType === 'global' || contextType === 'moments' ? 'global' : (isGroup ? 'group' : 'contact');
    const sessionSettings = context?.session?.settings && typeof context.session.settings === 'object'
      ? context.session.settings
      : {};
    const targetName =
      String(context?.character?.name || '').trim() ||
      String(this.contactsStore?.getContact?.(sessionId)?.name || '').trim() ||
      (isGroup ? sessionId.replace(/^group:/, '') : sessionId);

    const macroVars = {
      user: String(context?.user?.name || 'user'),
      char: String(context?.character?.name || 'assistant'),
      group: String(context?.group?.name || ''),
      members: Array.isArray(context?.group?.memberNames)
        ? context.group.memberNames.filter(Boolean).join(',')
        : '',
    };

    const injection = (template && typeof template === 'object' && template.injection) ? template.injection : {};
	    const templateRaw = typeof injection?.template === 'string' ? injection.template : '{{tableData}}';
	    const wrapperRaw = typeof injection?.wrapper === 'string' ? injection.wrapper : '<memories>\n{{tableData}}\n</memories>';
	    const overridePositionRaw = String(context?.meta?.memoryInjectPosition || '').trim().toLowerCase();
	    const templatePositions = parseMemoryPromptPositions(injection?.position);
	    const overridePositions =
	      overridePositionRaw
	        ? parseMemoryPromptPositions(overridePositionRaw)
	        : [];
	    const positions = overridePositions.length
	      ? overridePositions
	      : (templatePositions.length ? templatePositions : ['before_latest_user']);
    const position = positions.join('+');
    const guidePositionRaw = String(context?.meta?.memoryGuidePosition || '').trim().toLowerCase();
    const guidePositions = guidePositionRaw ? parseMemoryPromptPositions(guidePositionRaw) : [];
    const guidePosition = (guidePositions.length ? guidePositions : ['before_latest_user']).join('+');
    const guideInjectDepthRaw = Math.trunc(Number(context?.meta?.memoryGuideDepth));
    const guideInjectDepth = Number.isFinite(guideInjectDepthRaw) ? Math.max(0, guideInjectDepthRaw) : 0;

    const tables = Array.isArray(template?.tables) ? template.tables : [];
    const tableByIdAll = new Map();
    const tableById = new Map();
    const tableOrder = [];
    const allowSummaryTables = updateMode === 'summary' || updateMode === 'full';
    const allowStandardTables = updateMode === 'standard' || updateMode === 'full';
    const shouldIncludeTable = (tableId) => {
      const isSummary = isSummaryTableId(tableId);
      if (isSummary && !allowSummaryTables) return false;
      if (!isSummary && !allowStandardTables) return false;
      return true;
    };
    const matchesScope = (table) => {
      const scopeRaw = String(table?.scope || '').trim().toLowerCase();
      if (!scopeRaw) return true;
      if (scopeRaw === 'global') return true;
      if (scopeRaw === 'group') return isGroup;
      if (scopeRaw === 'contact') return !isGroup;
      return true;
    };
    tables.forEach(t => {
      const id = String(t?.id || '').trim();
      if (!id) return;
      tableByIdAll.set(id, t);
      if (!shouldIncludeTable(id)) return;
      if (!matchesScope(t)) return;
      if (!tableMatchesMemoryContext(t, { uiMode: context?.meta?.uiMode, sessionId, contextType, isGroup })) return;
      tableById.set(id, t);
      tableOrder.push(id);
    });

    const maxRows = memoryBudget.maxRows;
    const maxTokens = memoryBudget.maxTokens;
    const tokenBudgetSafety = Number.isFinite(maxTokens)
      ? Math.max(0, Math.floor(maxTokens * memoryBudget.safetyRatio))
      : maxTokens;
    const tokenMode = {
      mode: 'rough',
      // meta 缺失（不经主发送链的直接调用）时与主链同用保守默认，不得回退成 1 少估中文
      coefficient: Number(context?.meta?.tokenEstimateCalibration?.coefficient)
        || DEFAULT_CONSERVATIVE_COEFFICIENT,
    };
    const injectDepthRaw = Math.trunc(Number(context?.meta?.memoryInjectDepth));
    const injectDepth = Number.isFinite(injectDepthRaw) ? Math.max(0, injectDepthRaw) : 0;

    let scopedRows = [];
    let globalRows = [];
    try {
      if (contextType === 'global' || contextType === 'moments') {
        scopedRows = [];
      } else if (isGroup) {
        scopedRows = await this.memoryTableStore.getMemories({ scope: 'group', group_id: sessionId, template_id: templateId });
      } else {
        scopedRows = await this.memoryTableStore.getMemories({ scope: 'contact', contact_id: sessionId, template_id: templateId });
      }
    } catch {
      scopedRows = [];
    }
    try {
      globalRows = await this.memoryTableStore.getMemories({ scope: 'global', template_id: templateId });
    } catch {
      globalRows = [];
    }

    const resolveRequiredHints = () => {
      const hints = [];
      const rows = Array.isArray(scopedRows) ? scopedRows : [];
      if (!isGroup && sessionMode === 'chat') {
        const targetTableId = 'character_profile';
        const table = tableById.get(targetTableId);
        if (table) {
          const targetRows = rows.filter(row => String(row?.table_id || '').trim() === targetTableId && row?.is_active !== false);
          const requiredFields = ['personality'];
          const missing = [];
          if (!targetRows.length) {
            missing.push(...requiredFields);
          } else {
            const rowData = targetRows[0]?.row_data || {};
            requiredFields.forEach((fieldId) => {
              const value = normalizeMemoryCell(rowData?.[fieldId]).trim();
              if (!value) missing.push(fieldId);
            });
          }
          if (missing.length) {
            const columns = Array.isArray(table?.columns) ? table.columns : [];
            const fieldNames = missing.map((fieldId) => {
              const col = columns.find(c => String(c?.id || '').trim() === fieldId);
              return String(col?.name || fieldId || '').trim() || fieldId;
            });
            const tableLabel = String(table?.name || targetTableId).trim() || targetTableId;
            const action = targetRows.length ? 'update' : 'insert';
            hints.push(formatMemoryPromptText(
              'memory.edit.missing_fields',
              '系统检测：{table} 必填字段为空（{fields}）。请在 <tableEdit> 中使用 {action} 补全。',
              { table: tableLabel, fields: fieldNames.join(', '), action },
            ));
          }
        }
      }

      const { summaryTableId, outlineTableId } = getSummaryTableIdsForContext({
        uiMode: context?.meta?.uiMode,
        sessionId,
        contextType,
        isGroup,
      });
      const summaryTable = tableById.get(summaryTableId);
      if (summaryTable) {
        const summaryLabel = String(summaryTable?.name || summaryTableId).trim() || summaryTableId;
        hints.push(formatMemoryPromptText(
          'memory.edit.summary_required',
          '本轮必须新增{table}（摘要栏位使用“【摘要】...”格式；仅使用 insert）。',
          { table: summaryLabel },
        ));
      }
      const outlineTable = tableById.get(outlineTableId);
      if (outlineTable) {
        const outlineLabel = String(outlineTable?.name || outlineTableId).trim() || outlineTableId;
        hints.push(formatMemoryPromptText(
          'memory.edit.outline_check',
          '请检查{table}各分节；仅对本轮发生变化的分节执行 update/insert，禁止逐轮追加。',
          { table: outlineLabel },
        ));
      }
      return hints;
    };
    const requiredHints = autoExtract ? resolveRequiredHints() : [];
    const editGuide = autoExtract ? buildMemoryEditGuide({
      requiredHints,
      updateMode,
      tableOrder,
      tableById,
    }) : '';

    const emptyTemplate = renderStTemplate(templateRaw, { ...macroVars, tableData: '' });
    const emptyWrapped = wrapperRaw
      ? renderStTemplate(wrapperRaw, { ...macroVars, tableData: emptyTemplate })
      : emptyTemplate;
    const overheadTokens = estimateTokens(emptyWrapped, tokenMode) + (editGuide ? estimateTokens(editGuide, tokenMode) : 0);
    const tokenBudgetData = Math.max(0, tokenBudgetSafety - overheadTokens);
    const buildDataPromptText = (tableData) => {
      const renderedTemplate = renderStTemplate(templateRaw, { ...macroVars, tableData });
      const wrapped = wrapperRaw
        ? renderStTemplate(wrapperRaw, { ...macroVars, tableData: renderedTemplate })
        : renderedTemplate;
      const processed = this.processTextMacros(wrapped, { ...macroVars, sessionId });
      return String(processed || '').trim();
    };
    const buildPromptText = (tableData) => {
      const dataPromptText = buildDataPromptText(tableData);
      return [dataPromptText, autoExtract ? editGuide : ''].filter(Boolean).join('\n\n').trim();
    };

    const activeTableIds = new Set(tableOrder);
    const resolveRowScope = (row) => {
      if (row?.contact_id) return 'contact';
      if (row?.group_id) return 'group';
      return 'global';
    };
    const rowMatchesTableScope = (row, table) => {
      const tableScope = String(table?.scope || '').trim().toLowerCase();
      const rowScope = resolveRowScope(row);
      if (tableScope === 'global') return rowScope === 'global';
      if (tableScope === 'group') return rowScope === 'group';
      if (tableScope === 'contact') return rowScope === 'contact';
      return true;
    };
    const matchingRows = [...(Array.isArray(globalRows) ? globalRows : []), ...(Array.isArray(scopedRows) ? scopedRows : [])]
      .filter(Boolean)
      .filter(row => {
        const tableId = String(row?.table_id || '').trim();
        if (!activeTableIds.has(tableId)) return false;
        const table = tableById.get(tableId);
        return table ? rowMatchesTableScope(row, table) : false;
      });
    const rows = matchingRows.filter(row => row?.is_active !== false);
    // 分层逻辑收敛到共享纯函数：离线评测器回放同一实现，别在这里另写口径
    const rowLayers = buildMemoryPromptRowLayers(matchingRows);
    const workingRows = rowLayers.workingRows;
    const resolveRowSortKey = (row, tableId = '', fallback = 0) => resolveMemoryRowOrderKey(row, tableId, fallback);
    const limitedRows = rowLayers.limitedRows;
    const recallCandidateRows = rowLayers.recallCandidateRows;

    const localDemands = estimateMemorySegmentDemands({
      rows: limitedRows,
      tableById,
      tableOrder,
      autoExtract,
      tokenMode,
    });
    const inputBudgetContext = context?.meta?.inputBudgetContext || {};
    const worldSettings = this.getWorldGlobalSettings?.() || this.worldGlobalSettings || {};
    const budgetEnvelope = resolveMemoryBudgetEnvelope({
      settings: globalSettings,
      maxContextTokens: inputBudgetContext?.maxContextTokens,
      maxOutputTokens: inputBudgetContext?.maxOutputTokens,
      place: sessionMode,
      worldContextPercent: worldSettings?.contextPercent,
      worldBudgetCap: worldSettings?.budgetCap,
      demands: {
        state: localDemands.state,
        recent: estimatePromptMessagesTokens(context?.history || [], tokenMode),
        mid: localDemands.mid,
        far: localDemands.far,
        recall: Number.POSITIVE_INFINITY,
      },
    });
    let allocatedQuotas = budgetEnvelope?.allocation?.allocations
      ? { ...budgetEnvelope.allocation.allocations }
      : null;
    const planResult = buildSegmentedMemoryTablePlan({
      rows: limitedRows,
      tableById,
      tableOrder,
      autoExtract,
      maxRows,
      tokenQuotas: allocatedQuotas,
      tokenMode,
      preserveState: true,
    });
    const selected = planResult.items || [];
    const truncated = planResult.truncated || [];
    const tableData = planResult.tableData || '';
    const rowIndexMap = planResult.rowIndexMap || {};
    const tableOrderNext = planResult.tableOrder || tableOrder;
    const tableTargets = tableOrderNext.map((tableId) => {
      const table = tableById.get(tableId);
      const rowIds = Array.isArray(rowIndexMap?.[tableId])
        ? rowIndexMap[tableId].map(rowId => String(rowId || '').trim()).filter(Boolean)
        : [];
      return {
        id: String(tableId || '').trim(),
        name: String(table?.name || tableId || '').trim(),
        rowIds,
      };
    }).filter(target => target.id && target.name);
    const { summaryTableId: coverageSummaryTableId } = getSummaryTableIdsForContext({
      uiMode: context?.meta?.uiMode,
      sessionId,
      contextType,
      isGroup,
    });
    const coverageRows = rows
      .filter(row => String(row?.table_id || '').trim() === coverageSummaryTableId)
      .map(row => ({
        is_active: row?.is_active !== false,
        row_data: row?.row_data && typeof row.row_data === 'object' ? { ...row.row_data } : {},
      }));
    const coverageSource = {
      summaryTableId: coverageSummaryTableId,
      rows: coverageRows,
      totalTurns: Math.max(0, Math.trunc(Number(context?.meta?.memoryTotalTurns)) || 0),
    };
    let dynamicProfileDebug = null;
    const buildDynamicWeakTriggerText = () => {
      const historyLines = (Array.isArray(context?.history) ? context.history : [])
        .map(item => String(item?.content ?? '').trim())
        .filter(Boolean)
        .slice(-6);
      return [
        context?.meta?.rawUserMessage,
        context?.task?.triggerText,
        context?.task?.promptData,
        context?.task?.replyToAuthor,
        context?.task?.targetName,
        ...historyLines,
      ].map(item => String(item || '').trim()).filter(Boolean).join('\n');
    };

    const buildCrossScopeExtraText = async (budgetTokens) => {
      if (!this.memoryTableStore || budgetTokens <= 0) return { text: '', tokens: 0, segments: [] };
      const parts = [];
      let used = 0;
      const auditById = new Map();
      let activeAuditSegment = null;
      const setAuditSegment = (id, label) => {
        const key = String(id || '').trim();
        if (!key) {
          activeAuditSegment = null;
          return;
        }
        if (!auditById.has(key)) {
          auditById.set(key, {
            id: key,
            label: String(label || key).trim(),
            lines: [],
            usedTokens: 0,
            rowCount: 0,
          });
        }
        activeAuditSegment = auditById.get(key);
      };
      const getAuditSegments = () => Array.from(auditById.values())
        .filter(segment => segment.usedTokens > 0 || segment.rowCount > 0)
        .map(segment => ({
          id: segment.id,
          label: segment.label,
          text: segment.lines.join('\n').trim(),
          usedTokens: segment.usedTokens,
          rowCount: segment.rowCount,
        }));
      const buildCrossScopeResult = (text = parts.join('\n').trim()) => ({
        text: String(text || '').trim(),
        tokens: used,
        segments: getAuditSegments(),
      });
      const pushLine = (line) => {
        if (line === null || line === undefined) return true;
        const text = String(line);
        if (!text) {
          parts.push('');
          return true;
        }
        const cost = estimateTokens(text, tokenMode);
        if (used + cost > budgetTokens) return false;
        parts.push(text);
        used += cost;
        if (activeAuditSegment) {
          activeAuditSegment.lines.push(text);
          activeAuditSegment.usedTokens += cost;
          if (/^\s*-\s+\S/.test(text)) activeAuditSegment.rowCount += 1;
        }
        return true;
      };
      const pushSpacer = () => {
        if (parts.length && parts[parts.length - 1] !== '') parts.push('');
      };
      const resolvePromptSortKeyForTable = (row, tableId, fallback = 0) => {
        return resolveMemoryRowOrderKey(row, tableId, fallback);
      };
      const sortRowsForPrompt = (rows = [], tableId = '') => {
        const list = Array.isArray(rows) ? rows.slice() : [];
        list.sort((a, b) => {
          const af = resolveRowSortKey(a, 0);
          const bf = resolveRowSortKey(b, 0);
          const ak = resolvePromptSortKeyForTable(a, tableId, af);
          const bk = resolvePromptSortKeyForTable(b, tableId, bf);
          if (ak !== bk) return ak - bk;
          if (af !== bf) return af - bf;
          return String(a?.id || '').localeCompare(String(b?.id || ''));
        });
        return list;
      };
      const getRowText = (row, table) => {
        if (!table) return '';
        return formatMemoryRowText(row?.row_data || {}, table?.columns || [], table?.id || '');
      };
      const normalizeId = (cid) => String(cid || '').trim();
      const resolveContactName = (cid) => {
        const c = this.contactsStore?.getContact?.(cid);
        return String(c?.name || cid || '').trim();
      };
      const clampBridgeLimit = (raw, fallback) => normalizeBridgeLimit(raw, fallback);
      const pickNewestRows = (rows = [], limit = 0, tableId = '') => {
        const list = sortRowsForPrompt(rows, tableId);
        if (limit > 0 && list.length > limit) return list.slice(-limit);
        return list;
      };
      const appendOutlineRows = ({
        header,
        note = '',
        rows = [],
        table = null,
        limit = 0,
      } = {}) => {
        if (!table || !rows.length) return;
        const selectedRows = pickNewestRows(rows, limit, table?.id || '');
        if (!selectedRows.length) return;
        pushSpacer();
        if (!pushLine(header)) return;
        if (note) pushLine(note);
        selectedRows.forEach((row) => {
          const rowText = getRowText(row, table);
          if (!rowText) return;
          pushLine(`- ${rowText}`);
        });
      };
      const loadRowsForMemorySession = async (sourceId = '') => {
        const sid = normalizeId(sourceId);
        if (!sid) return [];
        const sourceIsGroup = sid.startsWith('group:');
        const rows = await this.memoryTableStore.getMemories({
          scope: sourceIsGroup ? 'group' : 'contact',
          group_id: sourceIsGroup ? sid : undefined,
          contact_id: sourceIsGroup ? undefined : sid,
          template_id: templateId,
        }).catch(() => []);
        return Array.isArray(rows) ? rows.filter(row => row && row.is_active !== false) : [];
      };
      const resolveSessionSourceName = (sourceId = '') => {
        const sid = normalizeId(sourceId);
        if (!sid) return '';
        if (isRpSessionId(sid)) {
          const rpName = normalizeId(this.getRpCharacterNameForSession?.(sid));
          if (rpName) return rpName;
        }
        if (sid.startsWith('group:')) {
          const groups = this.contactsStore?.listGroups?.() || [];
          const group = (Array.isArray(groups) ? groups : []).find((item) => {
            const gid = normalizeId(item?.id);
            return gid === sid || `group:${gid}` === sid;
          });
          const groupName = normalizeId(group?.name);
          if (groupName) return groupName;
        }
        return resolveContactName(sid) || sid;
      };
      const listMemorySessionIdsByMode = (mode = 'social') => {
        const list = this.chatStore?.listSessions?.() || [];
        return Array.from(new Set(
          (Array.isArray(list) ? list : [])
            .map(id => normalizeId(id))
            .filter(Boolean)
            .filter(id => id !== 'moments')
            .filter(id => (mode === 'rp' ? isRpSessionId(id) : !isRpSessionId(id))),
        ));
      };
      const collectMemorySourceRecords = async (sourceIds = []) => {
        const ids = Array.from(new Set((Array.isArray(sourceIds) ? sourceIds : [])
          .map(id => normalizeId(id))
          .filter(Boolean)));
        const records = [];
        for (const sourceId of ids) {
          const rows = await loadRowsForMemorySession(sourceId);
          if (!rows.length) continue;
          records.push({
            sourceId,
            sourceName: resolveSessionSourceName(sourceId),
            sourceIsGroup: sourceId.startsWith('group:'),
            rows,
          });
        }
        return records;
      };
      let momentsSocialRecordsCache = null;
      const getMomentsSocialRecords = async () => {
        if (momentsSocialRecordsCache) return momentsSocialRecordsCache;
        momentsSocialRecordsCache = await collectMemorySourceRecords(listMemorySessionIdsByMode('social'));
        return momentsSocialRecordsCache;
      };
      const resolveBridgeRecordHeader = (record = {}, sourceKind = '') => {
        const kind = String(sourceKind || record?.sourceKind || '').trim();
        if (kind === 'moments') return formatMemoryPromptText('memory.bridge.header_moments', '【动态】');
        if (kind === 'rp') return formatMemoryPromptText('memory.bridge.header_writing', '【创意写作】');
        const sourceId = normalizeId(record?.sourceId);
        const sourceNameRaw = normalizeId(record?.sourceName) || resolveSessionSourceName(sourceId) || sourceId;
        const sourceName = record?.sourceIsGroup
          ? sourceNameRaw.replace(/^group:/, '') || formatMemoryPromptText('memory.bridge.unknown_group', '未知群聊')
          : sourceNameRaw || formatMemoryPromptText('memory.bridge.unknown_contact', '未知联系人');
        if (record?.sourceIsGroup) {
          return formatMemoryPromptText('memory.bridge.group_header', '【群聊：{name}】', { name: sourceName });
        }
        return formatMemoryPromptText('memory.bridge.private_header', '【用户和{name}的私聊】', { name: sourceName });
      };
      const buildBridgeTableGroupsForRecord = ({
        record = null,
        tableIds = [],
        limit = 0,
        getLimitForTable = null,
        prefixRows = false,
      } = {}) => {
        const rows = Array.isArray(record?.rows) ? record.rows : [];
        if (!rows.length) return [];
        const groups = [];
        for (const tableId of Array.isArray(tableIds) ? tableIds : []) {
          const table = tableByIdAll.get(tableId);
          if (!table) continue;
          const rowsForTable = rows.filter(row => normalizeId(row?.table_id) === tableId);
          if (!rowsForTable.length) continue;
          const tableLimit = typeof getLimitForTable === 'function'
            ? normalizeBridgeLimit(getLimitForTable(tableId), limit)
            : normalizeBridgeLimit(limit, 0);
          const selectedRows = pickNewestRows(rowsForTable, tableLimit, tableId);
          const sourceName = normalizeId(record?.sourceName);
          const rowTexts = selectedRows
            .map((row) => {
              const rowText = getRowText(row, table);
              if (!rowText) return '';
              return prefixRows && sourceName ? joinMemoryPromptLabel(sourceName, rowText) : rowText;
            })
            .filter(Boolean);
          if (!rowTexts.length) continue;
          groups.push({
            tableId,
            label: getMemoryBridgeTablePromptLabel(tableId, table?.name || tableId),
            rows: rowTexts,
          });
        }
        return groups;
      };
      const appendYamlBridgeBlock = (header, tables = []) => {
        const title = normalizeId(header);
        const normalizedTables = (Array.isArray(tables) ? tables : [])
          .map(table => ({
            label: normalizeId(table?.label),
            rows: (Array.isArray(table?.rows) ? table.rows : [])
              .map(row => String(row || '').trim())
              .filter(Boolean),
          }))
          .filter(table => table.label && table.rows.length);
        if (!title || !normalizedTables.length) return false;
        const remaining = Math.max(0, budgetTokens - used);
        const tablesToFit = normalizedTables.map(table => ({ ...table, rows: [...table.rows] }));
        while (tablesToFit.length) {
          const lines = buildMemoryBridgeYamlLines({ header: title, tables: tablesToFit });
          const cost = lines.reduce((sum, line) => sum + (line ? estimateTokens(line, tokenMode) : 0), 0);
          if (lines.length && cost <= remaining) {
            pushSpacer();
            lines.forEach((line) => {
              pushLine(line);
            });
            return true;
          }
          let trimIndex = -1;
          let rowCount = 0;
          tablesToFit.forEach((table, index) => {
            if (table.rows.length > rowCount) {
              trimIndex = index;
              rowCount = table.rows.length;
            }
          });
          if (trimIndex < 0) break;
          tablesToFit[trimIndex].rows.shift();
          if (!tablesToFit[trimIndex].rows.length) tablesToFit.splice(trimIndex, 1);
        }
        return false;
      };
      const mergeBridgeTableGroups = (target, groups = []) => {
        groups.forEach((group) => {
          const tableId = normalizeId(group?.tableId || group?.label);
          const label = normalizeId(group?.label);
          const rows = (Array.isArray(group?.rows) ? group.rows : [])
            .map(row => String(row || '').trim())
            .filter(Boolean);
          if (!tableId || !label || !rows.length) return;
          if (!target.has(tableId)) target.set(tableId, { tableId, label, rows: [] });
          target.get(tableId).rows.push(...rows);
        });
      };
      const appendSourceRecordTables = ({
        records = [],
        tableIds = [],
        limit = 0,
        getLimitForTable = null,
        sourceKind = '',
        aggregateHeader = '',
        prefixRows = false,
      } = {}) => {
        const cleanRecords = (Array.isArray(records) ? records : [])
          .filter(record => Array.isArray(record?.rows) && record.rows.length);
        if (!cleanRecords.length) return;
        const orderedTableIds = (Array.isArray(tableIds) ? tableIds : [])
          .map(tableId => normalizeId(tableId))
          .filter(Boolean);
        if (!orderedTableIds.length) return;
        if (aggregateHeader) {
          const merged = new Map();
          cleanRecords.forEach((record) => {
            const groups = buildBridgeTableGroupsForRecord({
              record,
              tableIds: orderedTableIds,
              limit,
              getLimitForTable,
              prefixRows: prefixRows || cleanRecords.length > 1,
            });
            mergeBridgeTableGroups(merged, groups);
          });
          const tables = orderedTableIds.map(tableId => merged.get(tableId)).filter(Boolean);
          appendYamlBridgeBlock(aggregateHeader, tables);
          return;
        }
        cleanRecords.forEach((record) => {
          const groups = buildBridgeTableGroupsForRecord({
            record,
            tableIds: orderedTableIds,
            limit,
            getLimitForTable,
            prefixRows,
          });
          appendYamlBridgeBlock(resolveBridgeRecordHeader(record, sourceKind), groups);
        });
      };

      const sanitizeDynamicProfileDebug = (resolution = {}, { promptInjected = false } = {}) => {
        const sanitizeRows = rows => (Array.isArray(rows) ? rows : []).map(row => ({
          id: normalizeId(row?.id),
          tableId: normalizeId(row?.tableId),
          tableName: normalizeId(row?.tableName),
          rowSummary: String(row?.rowSummary || row?.rowText || '').trim().slice(0, 160),
          score: Number(row?.score || 0),
          matchedTerms: (Array.isArray(row?.matchedTerms) ? row.matchedTerms : [])
            .map(term => String(term || '').trim())
            .filter(Boolean)
            .slice(0, 8),
        })).filter(row => row.id || row.rowSummary);
        const sanitizeSource = source => ({
          contactId: normalizeId(source?.contactId),
          name: normalizeId(source?.name),
          scopeId: normalizeId(source?.scopeId),
          profileId: normalizeId(source?.profileId),
          hasProfile: source?.hasProfile === true,
          score: Number(source?.score || 0),
          status: normalizeId(source?.status || 'unknown'),
          blockedReason: normalizeId(source?.blockedReason),
          reasons: (Array.isArray(source?.reasons) ? source.reasons : []).map(normalizeId).filter(Boolean),
          matchedFields: (Array.isArray(source?.matchedFields) ? source.matchedFields : []).map(normalizeId).filter(Boolean),
          matchedTerms: (Array.isArray(source?.matchedTerms) ? source.matchedTerms : [])
            .map(term => String(term || '').trim())
            .filter(Boolean)
            .slice(0, 12),
          matchedRows: sanitizeRows(source?.matchedRows),
          profileHeader: String(source?.profileHeader || '').trim().slice(0, 180),
          sourceRefs: (Array.isArray(source?.sourceRefs) ? source.sourceRefs : []).map(normalizeId).filter(Boolean).slice(0, 20),
        });
        return {
          enabled: resolution?.enabled === true,
          scopeId: normalizeId(resolution?.scopeId || this.scopeId),
          threshold: Number(resolution?.threshold || 0),
          highThreshold: Number(resolution?.highThreshold || 0),
          profileHeaderThreshold: Number(resolution?.profileHeaderThreshold || 0),
          promptInjected,
          candidates: (Array.isArray(resolution?.candidates) ? resolution.candidates : []).map(sanitizeSource),
          selectedSources: (Array.isArray(resolution?.selectedSources) ? resolution.selectedSources : []).map(sanitizeSource),
          blockedCandidates: (Array.isArray(resolution?.blockedCandidates) ? resolution.blockedCandidates : []).map(sanitizeSource),
          injectedRows: (Array.isArray(resolution?.injectedRows) ? resolution.injectedRows : []).map(item => ({
            contactId: normalizeId(item?.contactId),
            contactName: normalizeId(item?.contactName),
            score: Number(item?.score || 0),
            matchedTerms: (Array.isArray(item?.matchedTerms) ? item.matchedTerms : []).map(normalizeId).filter(Boolean),
            row: sanitizeRows([item?.row])[0] || null,
          })).filter(item => item.contactId && item.row),
        };
      };

      const appendMomentWeakContactMemoryBlock = async () => {
        if (sessionMode !== 'moments') return;
        if (!this.contactProfileStore) return;
        const settings = this.contactProfileStore.getSettings?.() || {};
        if (settings.weakTriggerEnabled === false && settings.memoryWeakTriggerEnabled === false) {
          dynamicProfileDebug = sanitizeDynamicProfileDebug({ enabled: false }, { promptInjected: false });
          return;
        }
        const triggerText = buildDynamicWeakTriggerText();
        if (!triggerText.trim()) return;
        const sourceRecords = await getMomentsSocialRecords();
        if (!sourceRecords.length && !(this.contactProfileStore.listProfiles?.() || []).length) return;
        const records = sourceRecords.map(record => ({
          contactId: normalizeId(record?.sourceId),
          contactName: normalizeId(record?.sourceName),
          rows: (Array.isArray(record?.rows) ? record.rows : []).map((row) => {
            const tableId = normalizeId(row?.table_id);
            const table = tableByIdAll.get(tableId);
            const rowText = table ? getRowText(row, table) : '';
            if (!rowText) return null;
            return {
              id: normalizeId(row?.id),
              tableId,
              tableName: normalizeId(table?.name || tableId),
              rowText,
              rowSummary: rowText,
              updatedAt: Number(row?.updated_at || 0) || 0,
              sourceRef: row?.id ? `memory_row:${row.id}` : '',
            };
          }).filter(Boolean),
        })).filter(record => record.contactId && record.rows.length);
        const resolution = resolveContactProfileWeakTriggers({
          text: triggerText,
          profiles: this.contactProfileStore.listProfiles?.() || [],
          records,
          settings,
          scopeId: this.scopeId,
        });
        const promptText = buildContactProfileWeakTriggerPrompt(resolution, { settings });
        const injected = Boolean(promptText);
        dynamicProfileDebug = sanitizeDynamicProfileDebug(resolution, { promptInjected: injected });
        if (!promptText) return;
        pushSpacer();
        for (const line of promptText.split(/\r?\n/)) {
          if (!pushLine(line)) break;
        }
      };

      if (sessionMode === 'chat' && !isGroup) {
        setAuditSegment('memory_hardcoded_group_outline', '硬编码参考：所在群聊大纲');
        const contactId = sessionId;
        const groups = this.contactsStore?.listGroups?.() || [];
        const memberGroups = groups.filter(g => Array.isArray(g?.members) && g.members.includes(contactId));
        const outlineTable = tableByIdAll.get('group_outline');
        if (outlineTable && memberGroups.length) {
          if (!pushLine(formatMemoryPromptText(
            'memory.bridge.group_outline_header',
            '【跨会话参考｜群聊大纲】',
          ))) return buildCrossScopeResult('');
          pushLine(formatMemoryPromptText(
            'memory.bridge.group_outline_note',
            '（仅供当前私聊参考，不在本会话记忆表格中更新）',
          ));
          for (const group of memberGroups) {
            const groupId = String(group?.id || '').trim();
            if (!groupId) continue;
            const groupName = String(group?.name || groupId).trim();
            const groupRows = await this.memoryTableStore.getMemories({
              scope: 'group',
              group_id: groupId,
              template_id: templateId,
            }).catch(() => []);
            const outlineRows = sortRowsForPrompt((Array.isArray(groupRows) ? groupRows : [])
              .filter(row => row && row.is_active !== false)
              .filter(row => String(row?.table_id || '').trim() === 'group_outline'), 'group_outline');
            if (!outlineRows.length) continue;
            pushSpacer();
            if (!pushLine(`【${groupName}】`)) break;
            for (const row of outlineRows) {
              const rowText = getRowText(row, outlineTable);
              if (!rowText) continue;
              if (!pushLine(`- ${rowText}`)) break;
            }
          }
        }
      } else if (sessionMode === 'chat' && globalSettings.memoryGroupMemberReferenceEnabled !== false) {
        setAuditSegment('memory_hardcoded_member_private', '硬编码参考：群成员私聊');
        const groupMemberReferenceLimit = clampBridgeLimit(
          globalSettings.memoryGroupMemberReferenceLimit,
          5,
        );
        const groupContact = this.contactsStore?.getContact?.(sessionId);
        const members = Array.isArray(groupContact?.members)
          ? groupContact.members.map(item => normalizeId(item)).filter(Boolean)
          : [];
        const memberSet = new Set(members);
        const outlineTableId = 'chat_outline';
        const outlineTable = tableByIdAll.get(outlineTableId);
        if (members.length) {
          if (!pushLine(formatMemoryPromptText(
            'memory.bridge.member_private_header',
            '【跨会话参考｜成员私聊记忆】',
          ))) return buildCrossScopeResult('');
          pushLine(formatMemoryPromptText(
            'memory.bridge.member_private_note',
            '（以下为用户与各成员的私聊关系记忆，群内其他人不应知道；仅供模型掌握，勿在群聊中泄露）',
          ));
          for (const memberId of members) {
            const memberRows = await this.memoryTableStore.getMemories({
              scope: 'contact',
              contact_id: memberId,
              template_id: templateId,
            }).catch(() => []);
            const activeRows = (Array.isArray(memberRows) ? memberRows : [])
              .filter(row => row && row.is_active !== false);
            const filteredRows = activeRows.filter(row => {
              const tableId = normalizeId(row?.table_id);
              return tableId && !isSummaryTableId(tableId);
            });
            const outlineRows = outlineTable
              ? activeRows.filter(row => normalizeId(row?.table_id) === outlineTableId)
              : [];
            if (!filteredRows.length && !outlineRows.length) continue;
            const memberName = resolveContactName(memberId);
            pushSpacer();
            if (!pushLine(formatMemoryPromptText(
              'memory.bridge.member_header',
              '【成员：{name}】',
              { name: memberName || memberId },
            ))) break;
            const rowsByTable = new Map();
            filteredRows.forEach((row) => {
              const tableId = normalizeId(row?.table_id);
              if (!tableId) return;
              if (!rowsByTable.has(tableId)) rowsByTable.set(tableId, []);
              rowsByTable.get(tableId).push(row);
            });
            for (const [tableId, tableRows] of rowsByTable.entries()) {
              const table = tableByIdAll.get(tableId);
              if (!table) continue;
              const label = String(table?.name || tableId).trim() || tableId;
              const header = autoExtract ? `【${label}｜${tableId}】` : `【${label}】`;
              if (!pushLine(header)) return buildCrossScopeResult();
              const orderedRows = pickNewestRows(tableRows, groupMemberReferenceLimit, tableId);
              for (const row of orderedRows) {
                const rowText = getRowText(row, table);
                if (!rowText) continue;
                if (!pushLine(`- ${rowText}`)) return buildCrossScopeResult();
              }
            }
            if (outlineTable && outlineRows.length) {
              const outlineLabel = String(outlineTable?.name || outlineTableId).trim() || outlineTableId;
              const header = autoExtract ? `【${outlineLabel}｜${outlineTableId}】` : `【${outlineLabel}】`;
              if (!pushLine(header)) return buildCrossScopeResult();
              const orderedOutlineRows = pickNewestRows(
                outlineRows,
                groupMemberReferenceLimit,
                outlineTableId,
              );
              for (const row of orderedOutlineRows) {
                const rowText = getRowText(row, outlineTable);
                if (!rowText) continue;
                if (!pushLine(`- ${rowText}`)) return buildCrossScopeResult();
              }
            }
          }
        }
        const groupOutlineTable = tableByIdAll.get('group_outline');
        if (groupOutlineTable && members.length) {
          setAuditSegment('memory_hardcoded_related_group', '硬编码参考：相关群聊大纲');
          const groups = this.contactsStore?.listGroups?.() || [];
          const relatedGroups = groups
            .map(group => {
              const gid = normalizeId(group?.id);
              const groupMembers = Array.isArray(group?.members)
                ? group.members.map(item => normalizeId(item)).filter(Boolean)
                : [];
              return { group, gid, groupMembers };
            })
            .filter(item => item.gid && item.gid !== normalizeId(sessionId))
            .filter(item => item.groupMembers.some(memberId => memberSet.has(memberId)));
          if (relatedGroups.length) {
            if (!pushLine(formatMemoryPromptText(
              'memory.bridge.related_group_header',
              '【跨群聊参考｜相关群聊大纲】',
            ))) return buildCrossScopeResult('');
            pushLine(formatMemoryPromptText(
              'memory.bridge.related_group_note',
              '（以下为与当前群成员重叠的群聊大纲，仅共享成员知情）',
            ));
            for (const item of relatedGroups) {
              const groupId = item.gid;
              const groupName = String(item.group?.name || groupId).trim() || groupId;
              const groupRows = await this.memoryTableStore.getMemories({
                scope: 'group',
                group_id: groupId,
                template_id: templateId,
              }).catch(() => []);
              const outlineRows = pickNewestRows((Array.isArray(groupRows) ? groupRows : [])
                .filter(row => row && row.is_active !== false)
                .filter(row => normalizeId(row?.table_id) === 'group_outline'), groupMemberReferenceLimit, 'group_outline');
              if (!outlineRows.length) continue;
              const unknownMembers = members.filter(memberId => !item.groupMembers.includes(memberId));
              const unknownNames = unknownMembers.map(memberId => resolveContactName(memberId) || memberId).filter(Boolean);
              pushSpacer();
              if (!pushLine(`【${groupName}】`)) break;
              if (unknownNames.length) {
                if (!pushLine(formatMemoryPromptText(
                  'memory.bridge.unknown_members_note',
                  '（提示：本群聊中成员{names}未参与该群聊，不知道以下内容）',
                  { names: unknownNames.join(getMemoryPromptListSeparator()) },
                ))) break;
              }
              for (const row of outlineRows) {
                const rowText = getRowText(row, groupOutlineTable);
                if (!rowText) continue;
                if (!pushLine(`- ${rowText}`)) break;
              }
            }
          }
        }
      }

      if (sessionMode === 'chat') {
        setAuditSegment('memory_bridge_writing_to_chat', '记忆共享：创意写作 → 聊天');
        const rpBridgeSourceId = String(sessionSettings?.rpBridgeSourceSessionId || context?.meta?.defaultRpBridgeSessionId || '').trim();
        const rpTableSettings = resolveRpToChatBridgeTableSettings({
          sessionSettings,
          fallbackEnabled: globalSettings.memoryBridgeRpToChatEnabled !== false,
          fallbackLimit: clampBridgeLimit(globalSettings.memoryBridgeRpToChatLimit, 0),
        });
        const enabledRpTableIds = getRpToChatBridgeTableIds()
          .filter((tableId) => rpTableSettings?.[tableId]?.enabled === true);
        if (enabledRpTableIds.length && rpBridgeSourceId && rpBridgeSourceId !== sessionId) {
          const rpRows = await this.memoryTableStore.getMemories({
            scope: 'contact',
            contact_id: rpBridgeSourceId,
            template_id: templateId,
          }).catch(() => []);
          const activeRpRows = (Array.isArray(rpRows) ? rpRows : [])
            .filter(row => row && row.is_active !== false);
          appendSourceRecordTables({
            records: [{
              sourceId: rpBridgeSourceId,
              sourceName: resolveContactName(rpBridgeSourceId) || rpBridgeSourceId,
              sourceKind: 'rp',
              sourceIsGroup: false,
              rows: activeRpRows,
            }],
            tableIds: enabledRpTableIds,
            getLimitForTable: tableId => rpTableSettings?.[tableId]?.limit,
            sourceKind: 'rp',
            aggregateHeader: formatMemoryPromptText('memory.bridge.header_writing', '【创意写作】'),
          });
        }
      } else if (sessionMode === 'rp') {
        setAuditSegment('memory_bridge_chat_to_writing', '记忆共享：社交 → 创意写作');
        const rawChatBridgeSourceId = String(sessionSettings?.chatBridgeSourceSessionId || '').trim();
        const {
          sourceMode: chatBridgeSourceMode,
          sourceId: chatBridgeSourceId,
          sourceIsGroup,
        } = getChatToRpBridgeSourceMeta(rawChatBridgeSourceId);
        const tableSettings = resolveChatToRpBridgeTableSettings({
          sessionSettings,
          sourceIsGroup,
          sourceMode: chatBridgeSourceMode,
          fallbackEnabled: globalSettings.memoryBridgeChatToRpEnabled !== false,
          fallbackLimit: clampBridgeLimit(globalSettings.memoryBridgeChatToRpLimit, 5),
        });
        const enabledTableIds = getChatToRpBridgeTableIds({
          sourceIsGroup,
          sourceMode: chatBridgeSourceMode,
        }).filter((tableId) => tableSettings?.[tableId]?.enabled === true);
        if (chatBridgeSourceMode === 'all_social') {
          const socialSessionIds = (this.chatStore?.listSessions?.() || [])
            .map((id) => String(id || '').trim())
            .filter(Boolean)
            .filter((id) => !isRpSessionId(id))
            .filter((id) => id !== sessionId);
          if (enabledTableIds.length && socialSessionIds.length) {
            const sourceRecords = await Promise.all(socialSessionIds.map(async (sourceId) => {
              const currentSourceIsGroup = sourceId.startsWith('group:');
              const rows = await this.memoryTableStore.getMemories({
                scope: currentSourceIsGroup ? 'group' : 'contact',
                group_id: currentSourceIsGroup ? sourceId : undefined,
                contact_id: currentSourceIsGroup ? undefined : sourceId,
                template_id: templateId,
              }).catch(() => []);
              return {
                sourceId,
                sourceName: resolveSessionSourceName(sourceId) || sourceId,
                sourceIsGroup: currentSourceIsGroup,
                rows: Array.isArray(rows) ? rows.filter((row) => row && row.is_active !== false) : [],
              };
            }));
            appendSourceRecordTables({
              records: sourceRecords,
              tableIds: enabledTableIds,
              getLimitForTable: tableId => tableSettings?.[tableId]?.limit,
              sourceKind: 'social',
            });
          }
        } else if (enabledTableIds.length && chatBridgeSourceId && chatBridgeSourceId !== sessionId) {
          const sourceRows = await this.memoryTableStore.getMemories({
            scope: sourceIsGroup ? 'group' : 'contact',
            group_id: sourceIsGroup ? chatBridgeSourceId : undefined,
            contact_id: sourceIsGroup ? undefined : chatBridgeSourceId,
            template_id: templateId,
          }).catch(() => []);
          const activeSourceRows = (Array.isArray(sourceRows) ? sourceRows : [])
            .filter(row => row && row.is_active !== false);
          appendSourceRecordTables({
            records: [{
              sourceId: chatBridgeSourceId,
              sourceName: resolveSessionSourceName(chatBridgeSourceId) || chatBridgeSourceId,
              sourceIsGroup,
              rows: activeSourceRows,
            }],
            tableIds: enabledTableIds,
            getLimitForTable: tableId => tableSettings?.[tableId]?.limit,
            sourceKind: 'social',
          });
        }
      }
      if (
        (sessionMode === 'chat' || sessionMode === 'rp') &&
        globalSettings.memoryTableEnabledMoments !== false &&
        globalSettings.memoryBridgeMomentsToChatEnabled !== false
      ) {
        setAuditSegment('memory_bridge_moments_to_scene', '记忆共享：动态 → 当前场景');
        const momentsTableSettings = resolveMomentsToChatBridgeTableSettings({
          settings: globalSettings,
          fallbackEnabled: globalSettings.memoryBridgeMomentsToChatEnabled !== false,
          fallbackLimit: clampBridgeLimit(globalSettings.memoryBridgeMomentsToChatLimit, 5),
        });
        const enabledMomentTableIds = getMomentsToChatBridgeTableIds()
          .filter(tableId => momentsTableSettings?.[tableId]?.enabled === true);
        const momentRows = (Array.isArray(globalRows) ? globalRows : [])
          .filter(row => row && row.is_active !== false)
          .filter(row => enabledMomentTableIds.includes(normalizeId(row?.table_id)));
        appendSourceRecordTables({
          records: [{
            sourceId: 'moments',
            sourceName: formatMemoryPromptText('memory.bridge.header_moments', '【动态】'),
            sourceKind: 'moments',
            sourceIsGroup: false,
            rows: momentRows,
          }],
          tableIds: enabledMomentTableIds,
          limit: clampBridgeLimit(globalSettings.memoryBridgeMomentsToChatLimit, 5),
          getLimitForTable: tableId => momentsTableSettings?.[tableId]?.limit,
          sourceKind: 'moments',
          aggregateHeader: formatMemoryPromptText('memory.bridge.header_moments', '【动态】'),
        });
      }
      if (sessionMode === 'moments') {
        setAuditSegment('memory_dynamic_weak_recall', '动态弱触发召回');
        await appendMomentWeakContactMemoryBlock();
        if (
          globalSettings.memoryTableEnabledChat !== false &&
          globalSettings.memoryBridgeChatToMomentsEnabled !== false
        ) {
          setAuditSegment('memory_bridge_chat_to_moments', '记忆共享：社交 → 动态');
          const chatToMomentsTableSettings = resolveChatToMomentsBridgeTableSettings({
            settings: globalSettings,
            fallbackEnabled: globalSettings.memoryBridgeChatToMomentsEnabled !== false,
            fallbackLimit: clampBridgeLimit(globalSettings.memoryBridgeChatToMomentsLimit, 5),
          });
          const enabledChatToMomentsTableIds = getChatToMomentsBridgeTableIds()
            .filter(tableId => chatToMomentsTableSettings?.[tableId]?.enabled === true);
          const socialRecords = await getMomentsSocialRecords();
          appendSourceRecordTables({
            records: socialRecords,
            tableIds: enabledChatToMomentsTableIds,
            limit: clampBridgeLimit(globalSettings.memoryBridgeChatToMomentsLimit, 5),
            getLimitForTable: tableId => chatToMomentsTableSettings?.[tableId]?.limit,
            sourceKind: 'social',
          });
        }
        if (
          globalSettings.memoryTableEnabledWriting !== false &&
          globalSettings.memoryBridgeRpToMomentsEnabled !== false
        ) {
          setAuditSegment('memory_bridge_writing_to_moments', '记忆共享：创意写作 → 动态');
          const rpToMomentsTableSettings = resolveRpToMomentsBridgeTableSettings({
            settings: globalSettings,
            fallbackEnabled: globalSettings.memoryBridgeRpToMomentsEnabled !== false,
            fallbackLimit: clampBridgeLimit(globalSettings.memoryBridgeRpToMomentsLimit, 5),
          });
          const enabledRpToMomentsTableIds = getRpToMomentsBridgeTableIds()
            .filter(tableId => rpToMomentsTableSettings?.[tableId]?.enabled === true);
          const rpRecords = await collectMemorySourceRecords(listMemorySessionIdsByMode('rp'));
          appendSourceRecordTables({
            records: rpRecords,
            tableIds: enabledRpToMomentsTableIds,
            limit: clampBridgeLimit(globalSettings.memoryBridgeRpToMomentsLimit, 5),
            getLimitForTable: tableId => rpToMomentsTableSettings?.[tableId]?.limit,
            sourceKind: 'rp',
            aggregateHeader: formatMemoryPromptText('memory.bridge.header_writing', '【创意写作】'),
            prefixRows: rpRecords.length > 1,
          });
        }
      }
      return buildCrossScopeResult();
    };

    const baseTokens = tableData ? estimateTokens(tableData, tokenMode) : 0;
    const recallQuotaBeforeReflow = allocatedQuotas
      ? Math.max(0, Math.trunc(Number(allocatedQuotas.recall)) || 0)
      : Math.max(0, tokenBudgetData - baseTokens);
    const localRecallResult = buildMemoryKeywordRecallPlan({
      rows: recallCandidateRows,
      tableById,
      queryText: buildDynamicWeakTriggerText(),
      tokenBudget: recallQuotaBeforeReflow,
      maxRows: Math.max(0, maxRows - selected.length),
      tokenMode,
    });
    const remainingBudget = Math.max(0, recallQuotaBeforeReflow - localRecallResult.tokens);
    const extraResult = await buildCrossScopeExtraText(remainingBudget);
    const extraText = String(extraResult?.text || '').trim();
    const localRecallText = String(localRecallResult?.text || '').trim();
    const crossScopeAuditSegments = [
      ...(localRecallText || localRecallResult?.truncated?.length
        ? [{
            id: 'memory_keyword_recall',
            label: '关键词按需召回',
            text: localRecallText,
            usedTokens: localRecallResult.tokens,
            rowCount: localRecallResult.items.length,
            trimmedCount: localRecallResult.truncated.length,
            overflowed: localRecallResult.overflowed,
            detail: localRecallResult.detail || (
              localRecallResult.truncated.length
                ? `命中 ${localRecallResult.candidates.length} 条，但 Q_recall 配额不足`
                : ''
            ),
          }]
        : []),
      ...(Array.isArray(extraResult?.segments) ? extraResult.segments : []),
    ];
    const combinedTableData = [tableData, localRecallText, extraText].filter(Boolean).join('\n\n').trim();
    const recallUsedTokens = Math.min(
      recallQuotaBeforeReflow,
      Math.max(0, localRecallResult.tokens + (Number(extraResult?.tokens) || 0)),
    );
    if (allocatedQuotas) {
      allocatedQuotas = reflowUnusedRecallToRecent(
        allocatedQuotas,
        recallUsedTokens,
      ).allocations;
    }
    const buildPlanAudit = (dataPromptText = '', guidePromptText = '') => buildMemoryPlanAudit({
      localTableText: tableData,
      localRowCount: selected.length,
      localTrimmedCount: truncated.length,
      localSegments: planResult?.segments,
      crossScopeSegments: crossScopeAuditSegments,
      recallQuotaTokens: recallQuotaBeforeReflow,
      dataPromptText,
      guidePromptText,
      tokenMode,
    });
    const resolvedInputBudgetTokens = Number.isFinite(Number(budgetEnvelope?.inputBudgetTokens))
      ? Math.max(0, Math.trunc(Number(budgetEnvelope.inputBudgetTokens)))
      : null;
    const localAllocatedTokens = allocatedQuotas
      ? ['state', 'mid', 'far', 'recall'].reduce(
          (sum, segment) => sum + Math.max(0, Math.trunc(Number(allocatedQuotas[segment])) || 0),
          0,
        )
      : null;
    const planBudgetFields = {
      tokenBudget: resolvedInputBudgetTokens,
      tokenBudgetSafety: budgetEnvelope?.distributableTokens ?? null,
      tokenBudgetData: localAllocatedTokens,
      budget: {
        mode: budgetEnvelope?.mode || 'token',
        place: budgetEnvelope?.place || sessionMode,
        inputBudgetTokens: resolvedInputBudgetTokens,
        outputReserveTokens: budgetEnvelope?.input?.maxOutputTokens ?? null,
        safetyReserveTokens: budgetEnvelope?.input?.safetyReserveTokens ?? 512,
        fixedReserveTokens: budgetEnvelope?.fixedReserveTokens ?? 0,
        worldBudgetTokens: budgetEnvelope?.worldBudgetTokens ?? null,
        distributableTokens: budgetEnvelope?.distributableTokens ?? null,
        ratios: budgetEnvelope?.allocation?.ratios || null,
        baseQuotas: budgetEnvelope?.allocation?.baseQuotas || null,
        allocations: allocatedQuotas,
        overQuotaSegments: Array.from(new Set([
          ...(budgetEnvelope?.allocation?.overQuotaSegments || []),
          ...(localRecallResult.overflowed ? ['recall'] : []),
        ])),
      },
      coverageSource,
      segmentStats: Object.fromEntries(
        [
          ...Object.entries(planResult?.segments || {}),
          ['recall', {
            demandTokens: localRecallResult.demandTokens,
            quotaTokens: recallQuotaBeforeReflow,
            usedTokens: recallUsedTokens,
            items: localRecallResult.items,
            truncated: localRecallResult.truncated,
            overflowed: localRecallResult.overflowed,
          }],
        ].map(([segment, stats]) => [segment, {
          demandTokens: stats?.demandTokens ?? 0,
          quotaTokens: stats?.quotaTokens ?? null,
          usedTokens: stats?.usedTokens ?? 0,
          rowCount: Array.isArray(stats?.items) ? stats.items.length : 0,
          trimmedCount: Array.isArray(stats?.truncated) ? stats.truncated.length : 0,
          overflowed: stats?.overflowed === true,
        }]),
      ),
    };

    if (!selected.length && !truncated.length && !combinedTableData) {
      const promptText = autoExtract ? buildPromptText('') : '';
      const tokenTotal = promptText ? estimateTokens(promptText, tokenMode) : 0;
      const dataPromptText = autoExtract ? buildDataPromptText('') : '';
      const guidePromptText = autoExtract ? editGuide : '';
      return {
        enabled: true,
        reason: 'empty',
        items: [],
        truncated: [],
        tokenTotal,
        ...planBudgetFields,
        overheadTokens,
        maxRows,
        position,
        injectDepth,
        promptText,
        dataPromptText,
        guidePromptText,
	        guidePosition,
	        guideInjectDepth,
	        tableData: '',
	        dynamicProfileDebug,
	        updateMode,
        templateId,
        templateName,
        targetId: sessionId,
        targetName,
        scope,
        autoExtract,
        tableOrder: tableOrderNext,
        rowIndexMap: {},
        tableTargets,
        audit: buildPlanAudit(dataPromptText, guidePromptText),
      };
    }

    if (!selected.length && !combinedTableData) {
      const promptText = autoExtract ? buildPromptText('') : '';
      const tokenTotal = promptText ? estimateTokens(promptText, tokenMode) : 0;
      const dataPromptText = autoExtract ? buildDataPromptText('') : '';
      const guidePromptText = autoExtract ? editGuide : '';
      return {
        enabled: true,
        reason: 'budget_empty',
        items: [],
        truncated,
        tokenTotal,
        ...planBudgetFields,
        overheadTokens,
        maxRows,
        position,
        injectDepth,
        promptText,
        dataPromptText,
        guidePromptText,
	        guidePosition,
	        guideInjectDepth,
	        tableData: '',
	        dynamicProfileDebug,
	        updateMode,
        templateId,
        templateName,
        targetId: sessionId,
        targetName,
        scope,
        autoExtract,
        tableOrder: tableOrderNext,
        rowIndexMap: {},
        tableTargets,
        audit: buildPlanAudit(dataPromptText, guidePromptText),
      };
    }

    const dataPromptText = buildDataPromptText(combinedTableData);
    const guidePromptText = autoExtract ? editGuide : '';
    const promptText = [dataPromptText, guidePromptText].filter(Boolean).join('\n\n').trim();
    const tokenTotal = estimateTokens(promptText, tokenMode);

    return {
      enabled: true,
      reason: '',
      items: selected,
      recallItems: localRecallResult.items,
      recallDebug: {
        queryTerms: localRecallResult.queryTerms,
        candidateCount: localRecallResult.candidates.length,
        matchedCount: localRecallResult.items.length,
        trimmedCount: localRecallResult.truncated.length,
        detail: localRecallResult.detail,
      },
      truncated,
      tokenTotal,
      ...planBudgetFields,
      overheadTokens,
      maxRows,
      position,
      injectDepth,
      promptText,
      dataPromptText,
	      guidePromptText,
	      guidePosition,
	      guideInjectDepth,
	      tableData,
	      dynamicProfileDebug,
	      updateMode,
      templateId,
      templateName,
      targetId: sessionId,
      targetName,
      scope,
      autoExtract,
      tableOrder: tableOrderNext,
      rowIndexMap,
      tableTargets,
      audit: buildPlanAudit(dataPromptText, guidePromptText),
    };
  }

  async getMemoryPromptPlan(context = null) {
    const ctx = context || (this.contextBuilder ? this.contextBuilder('') : null) || {};
    const plan = await this.buildMemoryPromptPlan(ctx);
    this.lastMemoryPlan = plan;
    return plan;
  }

  setLastMemoryUpdate(sessionId, payload = null) {
    const id = String(sessionId || '').trim();
    if (!id) return;
    if (!payload) {
      delete this.lastMemoryUpdateBySession[id];
      return;
    }
    this.lastMemoryUpdateBySession[id] = { ...(payload || {}), sessionId: id };
  }

  getLastMemoryUpdate(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) return null;
    return this.lastMemoryUpdateBySession?.[id] || null;
  }

  getLastMemoryPlan() {
    return this.lastMemoryPlan || null;
  }

  setLastMemoryPlan(plan = null) {
    this.lastMemoryPlan = plan || null;
  }

  async ensureBuiltinWorldbooks() {
    await this.worldStore.ready;
    try {
      const snapshot = await this.getWorldInfoSnapshot(BUILTIN_PHONE_FORMAT_WORLDBOOK_ID);
      const existing = snapshot.data;
      const incoming = BUILTIN_PHONE_FORMAT_WORLDBOOK;
      const saveOptions = {
        expectedRevision: snapshot.revision,
        expectedGeneration: snapshot.generation,
        expectedExists: snapshot.exists,
        conflictMode: 'return',
      };
      if (!existing || !Array.isArray(existing.entries)) {
        const result = await this.saveWorldInfo(BUILTIN_PHONE_FORMAT_WORLDBOOK_ID, incoming, saveOptions);
        if (result?.ok === false) {
          logger.warn('内置世界书迁移期间内容已变化，本次跳过');
          return;
        }
        logger.info(`已写入内置世界书：${BUILTIN_PHONE_FORMAT_WORLDBOOK_ID}`);
        return;
      }
      const byComment = new Map();
      for (const e of existing.entries || []) {
        const key = String(e?.comment || e?.title || e?.id || '').trim();
        if (key) byComment.set(key, e);
      }
      let changed = false;
      const merged = [];
      const incomingKeys = new Set();
      for (const ie of incoming.entries || []) {
        const key = String(ie?.comment || ie?.title || ie?.id || '').trim();
        if (!key) continue;
        incomingKeys.add(key);
        const cur = byComment.get(key);
        if (!cur) {
          merged.push(ie);
          changed = true;
          continue;
        }
        const next = { ...cur, ...ie };
        if (JSON.stringify(next) !== JSON.stringify(cur)) changed = true;
        merged.push(next);
      }
      for (const e of existing.entries || []) {
        const key = String(e?.comment || e?.title || e?.id || '').trim();
        if (key && incomingKeys.has(key)) continue;
        merged.push(e);
      }
      if (changed) {
        const result = await this.saveWorldInfo(
          BUILTIN_PHONE_FORMAT_WORLDBOOK_ID,
          { ...existing, entries: merged },
          saveOptions,
        );
        if (result?.ok === false) {
          logger.warn('内置世界书迁移期间内容已变化，本次跳过');
          return;
        }
        logger.info(`已更新内置世界书：${BUILTIN_PHONE_FORMAT_WORLDBOOK_ID}`);
      }
    } catch (err) {
      logger.warn('内置世界书迁移失败（忽略）', err);
    }
  }

  normalizeMomentMediaMode(value = '', autoImagePromptEnabled = false) {
    if (!autoImagePromptEnabled) return 'placeholder';
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'image_prompt' || raw === 'ai' || raw === 'placeholder') return raw;
    return 'ai';
  }

  buildMomentMediaModePrompt(mode = 'placeholder', { localized = true } = {}) {
    let key = 'moment_media.placeholder';
    let fallback;
    if (mode === 'image_prompt') {
      key = 'moment_media.image_prompt';
      fallback = [
        '动态如果有配图,使用<image_prompt>标签格式',
        '如{{user}}--我好看吗<image_prompt>自拍提示词</image_prompt>--12:00--67--32',
        '禁止同时使用[img-内容]；禁止输出[img-说明文字]<image_prompt>...</image_prompt>',
      ].join('\n');
    } else if (mode === 'ai') {
      key = 'moment_media.ai';
      fallback = [
        '动态如果有配图,请决策要使用[img-内容]这个格式还是使用<image_prompt>标签进行文生图',
        '如{{user}}--我好看吗[img-一张自拍]--12:00--67--32',
        '或',
        '{{user}}--我好看吗<image_prompt>自拍提示词</image_prompt>--12:00--67--32',
        '禁止在同一条动态中同时出现[img-...]和<image_prompt>；禁止输出[img-说明文字]<image_prompt>...</image_prompt>',
      ].join('\n');
    } else {
      fallback = [
        '动态如果有配图,使用[img-内容]这个格式',
        '如{{user}}--我好看吗[img-一张自拍]--12:00--67--32',
      ].join('\n');
    }
    return localized ? getLocalizedPromptText(key, fallback) : fallback;
  }

  replaceMomentMediaModePrompt(content, mode = 'placeholder') {
    const raw = String(content || '');
    if (!raw.trim()) return raw;
    const replacement = this.buildMomentMediaModePrompt(mode);
    for (const candidateMode of ['placeholder', 'image_prompt', 'ai']) {
      const canonical = this.buildMomentMediaModePrompt(candidateMode, { localized: false });
      const active = this.buildMomentMediaModePrompt(candidateMode);
      if (canonical && raw.includes(canonical)) return raw.replace(canonical, replacement);
      if (active && active !== canonical && raw.includes(active)) return raw.replace(active, replacement);
    }
    const blockRe = /动态如果有配图[^\n\r]*(?:(?:\r?\n)(?!(?:但是角色发布的动态可以有路人参与评论|路人必须生成具体网名|每条动态|使用moment_start|请勿生成多个|<发布动态的目的与时机>|<\/QQ空间格式介绍>))[^\n\r]*){0,5}/;
    if (blockRe.test(raw)) return raw.replace(blockRe, replacement);
    if (raw.includes('但是角色发布的动态可以有路人参与评论')) {
      return raw.replace('但是角色发布的动态可以有路人参与评论', `${replacement}\n但是角色发布的动态可以有路人参与评论`);
    }
    if (raw.includes('</QQ空间格式介绍>')) {
      return raw.replace('</QQ空间格式介绍>', `${replacement}\n\n</QQ空间格式介绍>`);
    }
    return `${raw.replace(/\s+$/, '')}\n${replacement}`;
  }

  replaceMomentPurposeBlockWithDecisionPrompt(content, decisionPrompt) {
    const raw = String(content || '');
    const prompt = String(decisionPrompt || '')
      .replace(/(?:\r?\n[ \t]*){3,}/g, '\n\n')
      .replace(/^(?:[ \t]*\r?\n)+/, '')
      .replace(/(?:\r?\n[ \t]*)+$/, '');
    if (!raw.trim() || !prompt) return raw;
    const replacement = `<发布动态的目的与时机>\n${prompt}\n</发布动态的目的与时机>`;
    const blockRe = /<发布动态的目的与时机>[\s\S]*?<\/发布动态的目的与时机>/;
    if (blockRe.test(raw)) return raw.replace(blockRe, replacement);
    if (raw.includes('</QQ空间格式介绍>')) {
      return raw.replace('</QQ空间格式介绍>', `${replacement}\n\n</QQ空间格式介绍>`);
    }
    return `${raw.replace(/\s+$/, '')}\n\n${replacement}`;
  }

  applyAutoImageModeToPhoneFormat(content, autoImagePromptEnabled = false) {
    const raw = String(content || '');
    if (!raw) return raw;
    const localizedLegacy = getLocalizedPromptText('phone_image_rules.legacy', LEGACY_PHONE_IMAGE_MESSAGE_RULES);
    const localizedCurrent = getLocalizedPromptText('phone_image_rules.current', CURRENT_PHONE_IMAGE_MESSAGE_RULES);
    if (autoImagePromptEnabled) {
      if (raw.includes(localizedLegacy)) return raw.split(localizedLegacy).join(localizedCurrent);
      return raw.split(LEGACY_PHONE_IMAGE_MESSAGE_RULES).join(CURRENT_PHONE_IMAGE_MESSAGE_RULES);
    }
    if (raw.includes(localizedCurrent)) return raw.split(localizedCurrent).join(localizedLegacy);
    return raw.split(CURRENT_PHONE_IMAGE_MESSAGE_RULES).join(LEGACY_PHONE_IMAGE_MESSAGE_RULES);
  }

  buildPhoneFormatPromptEntries(preset = null, options = {}) {
    const source = (preset && typeof preset === 'object') ? preset : {};
    const seed = getBuiltinPhoneFormatPromptSeed(BUILTIN_PHONE_FORMAT_WORLDBOOK);
    const momentCreateRules = String(options?.momentCreateRules || '')
      .replace(/(?:\r?\n[ \t]*){3,}/g, '\n\n')
      .replace(/^(?:[ \t]*\r?\n)+/, '')
      .replace(/(?:\r?\n[ \t]*)+$/, '');
    const momentMediaMode = this.normalizeMomentMediaMode(
      options?.momentMediaMode,
      options?.autoImagePromptEnabled === true,
    );
    const out = [];
    BUILTIN_PHONE_FORMAT_CHAT_PROMPT_SPECS.forEach((spec, index) => {
      if (source?.[spec.enabledKey] === false) return;
      const raw = typeof source?.[spec.rulesKey] === 'string' && source[spec.rulesKey].trim()
        ? source[spec.rulesKey]
        : String(seed?.[spec.rulesKey] ?? '');
      let content = String(raw ?? '');
      if (spec.rulesKey === 'phone_format_chat_rules') {
        content = this.applyAutoImageModeToPhoneFormat(
          content,
          options?.autoImagePromptEnabled === true,
        );
      }
      if (spec.rulesKey === 'phone_format_moment_rules') {
        content = this.replaceMomentMediaModePrompt(content, momentMediaMode);
      }
      if (spec.rulesKey === 'phone_format_moment_rules' && momentCreateRules) {
        content = this.replaceMomentPurposeBlockWithDecisionPrompt(content, momentCreateRules);
      }
      if (!content.trim()) return;
      const order = Number.isFinite(Number(spec.order)) ? Number(spec.order) : index;
      out.push({
        id: spec.entryId,
        comment: spec.entryId,
        title: spec.title,
        content,
        order,
        priority: order,
        depth: 0,
        position: 0,
        role: 0,
        constant: true,
        disable: false,
        _src: 'builtin',
        _sourceWorldId: '',
        _refWorldId: '',
        _entryId: spec.entryId,
        _entryTitle: spec.title,
        _transportLayerId: spec.transportLayerId,
        _promptPosition: normalizePhoneFormatPromptPosition(source?.[spec.positionKey]),
        _promptDepth: normalizePhoneFormatPromptDepth(source?.[spec.depthKey]),
      });
    });
    return out;
  }

  async ensurePhoneFormatChatPromptMigration() {
    await this.presets.ready;
    try {
      const sourceWorldbook = this.worldStore.load(BUILTIN_PHONE_FORMAT_WORLDBOOK_ID) || BUILTIN_PHONE_FORMAT_WORLDBOOK;
      const seed = getBuiltinPhoneFormatPromptSeed(sourceWorldbook);
      const next = this.presets.getState();
      const syspromptPresets = next?.presets?.sysprompt;
      if (!syspromptPresets || typeof syspromptPresets !== 'object') return;

      let changed = false;
      Object.values(syspromptPresets).forEach((preset) => {
        if (!preset || typeof preset !== 'object') return;
        BUILTIN_PHONE_FORMAT_CHAT_PROMPT_SPECS.forEach((spec) => {
          if (typeof preset[spec.enabledKey] !== 'boolean') {
            preset[spec.enabledKey] = seed[spec.enabledKey] !== false;
            changed = true;
          }
          if (typeof preset[spec.rulesKey] !== 'string' || !preset[spec.rulesKey].trim()) {
            preset[spec.rulesKey] = String(seed[spec.rulesKey] ?? '');
            changed = true;
          }
          const position = normalizePhoneFormatPromptPosition(preset[spec.positionKey]);
          if (preset[spec.positionKey] !== position) {
            preset[spec.positionKey] = position;
            changed = true;
          }
          const depth = normalizePhoneFormatPromptDepth(preset[spec.depthKey]);
          if (preset[spec.depthKey] !== depth) {
            preset[spec.depthKey] = depth;
            changed = true;
          }
        });
      });

      if (changed) {
        await this.presets.persist(next);
        logger.info('已将旧手机格式世界书迁移到聊天提示词固定区块');
      }
    } catch (err) {
      logger.warn('手机格式聊天提示词迁移失败（忽略）', err);
    }
  }

  scheduleDeferredWorldBootstrap({ delayMs = 220 } = {}) {
    if (this.worldBootstrapCompleted || this.worldBootstrapScheduled) return;
    this.worldBootstrapScheduled = true;
    const runner = () => {
      this.worldBootstrapScheduled = false;
      this.runDeferredWorldBootstrap().catch((err) => {
        logger.warn('世界书后台启动迁移失败', err);
      });
    };
    try {
      const g = typeof globalThis !== 'undefined' ? globalThis : window;
      if (typeof g?.requestIdleCallback === 'function') {
        g.requestIdleCallback(() => runner(), { timeout: Math.max(200, delayMs) });
        return;
      }
    } catch {}
    setTimeout(runner, Math.max(80, delayMs));
  }

  async runDeferredWorldBootstrap() {
    if (this.worldBootstrapCompleted) return;
    if (this._worldBootstrapPromise) return this._worldBootstrapPromise;
    this._worldBootstrapPromise = (async () => {
      try {
        await this.ensureBuiltinWorldbooks();
        await this.ensurePhoneFormatChatPromptMigration();
        this.worldBootstrapCompleted = true;
      } finally {
        this.worldBootstrapScheduled = false;
      }
    })();
    return this._worldBootstrapPromise;
  }

  getWorldSessionMapKey() {
    return makeScopedKey('world_session_map_v1', this.scopeId);
  }

  getGlobalWorldIdKey() {
    return 'global_world_id_shared_v1';
  }

  getGlobalWorldIdsKey() {
    return 'global_world_ids_shared_v1';
  }

  getLegacyScopedGlobalWorldIdKey() {
    return makeScopedKey('global_world_id_v1', this.scopeId);
  }

  getWorldGlobalSettingsKey() {
    return 'world_global_settings_shared_v1';
  }

  getLegacyScopedWorldGlobalSettingsKey() {
    return makeScopedKey('world_global_settings_v1', this.scopeId);
  }

  normalizeWorldIds(value) {
    const list = Array.isArray(value) ? value : (value ? [value] : []);
    return list.map(item => String(item || '').trim()).filter(Boolean);
  }

  getPersonaScope() {
    return this.scopeId || '';
  }

  setPersonaScope(scopeId = '') {
    const next = normalizeScopeId(scopeId);
    if (next === this.scopeId) return;
    this.scopeId = next;
    this.worldSessionMap = this.loadWorldSessionMap();
    this.globalWorldIds = this.loadGlobalWorldIds();
    this.globalWorldId = this.globalWorldIds[0] || null;
    this.worldGlobalSettings = this.loadWorldGlobalSettings();
    this.currentWorldIds = this.activeSessionId ? this.normalizeWorldIds(this.worldSessionMap[this.activeSessionId]) : [];
    this.currentWorldId = this.currentWorldIds[0] || null;
    this.hydrateWorldSessionMap();
    this.hydrateGlobalWorldId();
    this.hydrateWorldGlobalSettings();
    this.syncWorldRegexBindings?.();
    this.emitWorldInfoChanged({ scopeId: this.scopeId });
  }

  normalizeStoredGlobalWorldIds(value) {
    if (Array.isArray(value)) return Array.from(new Set(this.normalizeWorldIds(value)));
    const raw = String(value ?? '').trim();
    if (!raw) return [];
    if (raw.startsWith('[') || raw.startsWith('"')) {
      try {
        return Array.from(new Set(this.normalizeWorldIds(JSON.parse(raw))));
      } catch {}
    }
    return Array.from(new Set(this.normalizeWorldIds(raw)));
  }

  loadGlobalWorldIds() {
    try {
      const plural = localStorage.getItem(this.getGlobalWorldIdsKey());
      if (plural !== null) return this.normalizeStoredGlobalWorldIds(plural);
      const raw = localStorage.getItem(this.getGlobalWorldIdKey());
      if (raw !== null) return this.normalizeStoredGlobalWorldIds(raw);
      const legacy = localStorage.getItem(this.getLegacyScopedGlobalWorldIdKey());
      if (legacy !== null) {
        const migrated = this.normalizeStoredGlobalWorldIds(legacy);
        try {
          localStorage.setItem(this.getGlobalWorldIdsKey(), JSON.stringify(migrated));
          localStorage.setItem(this.getGlobalWorldIdKey(), migrated[0] || '');
        } catch {}
        return migrated;
      }
      return [];
    } catch {
      return [];
    }
  }

  loadGlobalWorldId() {
    return this.loadGlobalWorldIds()[0] || null;
  }

  getDefaultWorldGlobalSettings() {
    return {
      scanDepth: 2,
      insertionStrategy: 'role_first',
      contextPercent: 20,
      includeNames: false,
      budgetCap: 0,
      minActivations: 0,
      maxDepth: 0,
      maxRecursionSteps: 0,
      recursiveScan: true,
      caseSensitive: false,
      matchWholeWords: true,
      useGroupScoring: false,
      alertOnOverflow: false,
      variableDefineStrategy: 'legacy_eager',
    };
  }

  normalizeWorldGlobalSettings(value) {
    const base = this.getDefaultWorldGlobalSettings();
    const obj = value && typeof value === 'object' ? value : {};
    const scanDepthRaw = obj.scanDepth;
    const scanDepth = (scanDepthRaw === null || scanDepthRaw === '' || scanDepthRaw === undefined)
      ? base.scanDepth
      : (Number.isFinite(Number(scanDepthRaw)) ? Math.max(0, Math.trunc(Number(scanDepthRaw))) : base.scanDepth);
    const insertionStrategy = normalizeWorldInsertionStrategy(
      obj.insertionStrategy,
      base.insertionStrategy,
    );
    const contextRaw = obj.contextPercent;
    const contextPercent = (contextRaw === null || contextRaw === '' || contextRaw === undefined)
      ? base.contextPercent
      : (Number.isFinite(Number(contextRaw)) ? Math.max(0, Math.min(100, Math.trunc(Number(contextRaw)))) : base.contextPercent);
    const budgetRaw = obj.budgetCap;
    const budgetCap = (budgetRaw === null || budgetRaw === '' || budgetRaw === undefined)
      ? base.budgetCap
      : (Number.isFinite(Number(budgetRaw)) ? Math.max(0, Math.trunc(Number(budgetRaw))) : base.budgetCap);
    const minActRaw = obj.minActivations;
    const minActivations = (minActRaw === null || minActRaw === '' || minActRaw === undefined)
      ? base.minActivations
      : (Number.isFinite(Number(minActRaw)) ? Math.max(0, Math.trunc(Number(minActRaw))) : base.minActivations);
    const maxDepthRaw = obj.maxDepth;
    const maxDepth = (maxDepthRaw === null || maxDepthRaw === '' || maxDepthRaw === undefined)
      ? base.maxDepth
      : (Number.isFinite(Number(maxDepthRaw)) ? Math.max(0, Math.trunc(Number(maxDepthRaw))) : base.maxDepth);
    const maxRecursionRaw = obj.maxRecursionSteps;
    const maxRecursionSteps = (maxRecursionRaw === null || maxRecursionRaw === '' || maxRecursionRaw === undefined)
      ? base.maxRecursionSteps
      : (Number.isFinite(Number(maxRecursionRaw)) ? Math.max(0, Math.trunc(Number(maxRecursionRaw))) : base.maxRecursionSteps);
    const includeNames = obj.includeNames === undefined || obj.includeNames === null ? base.includeNames : obj.includeNames === true;
    const recursiveScan = obj.recursiveScan === undefined || obj.recursiveScan === null ? base.recursiveScan : obj.recursiveScan === true;
    const caseSensitive = obj.caseSensitive === undefined || obj.caseSensitive === null ? base.caseSensitive : obj.caseSensitive === true;
    const matchWholeWords = obj.matchWholeWords === undefined || obj.matchWholeWords === null ? base.matchWholeWords : obj.matchWholeWords === true;
    const useGroupScoring = obj.useGroupScoring === undefined || obj.useGroupScoring === null ? base.useGroupScoring : obj.useGroupScoring === true;
    const alertOnOverflow = obj.alertOnOverflow === undefined || obj.alertOnOverflow === null ? base.alertOnOverflow : obj.alertOnOverflow === true;
    const variableDefineStrategy = normalizeWorldVariableDefineStrategy(
      obj.variableDefineStrategy,
      base.variableDefineStrategy,
    );
    return {
      scanDepth,
      insertionStrategy,
      contextPercent,
      includeNames,
      budgetCap,
      minActivations,
      maxDepth,
      maxRecursionSteps,
      recursiveScan,
      caseSensitive,
      matchWholeWords,
      useGroupScoring,
      alertOnOverflow,
      variableDefineStrategy,
    };
  }

  loadWorldGlobalSettings() {
    try {
      const raw = localStorage.getItem(this.getWorldGlobalSettingsKey());
      if (raw) return this.normalizeWorldGlobalSettings(JSON.parse(raw));
      const legacy = localStorage.getItem(this.getLegacyScopedWorldGlobalSettingsKey());
      if (!legacy) return this.getDefaultWorldGlobalSettings();
      const normalized = this.normalizeWorldGlobalSettings(JSON.parse(legacy));
      try {
        localStorage.setItem(this.getWorldGlobalSettingsKey(), JSON.stringify(normalized));
      } catch {}
      return normalized;
    } catch {
      return this.getDefaultWorldGlobalSettings();
    }
  }

  loadWorldSessionMap() {
    try {
      const raw = localStorage.getItem(this.getWorldSessionMapKey());
      return raw ? JSON.parse(raw) : {};
    } catch (err) {
      logger.warn('world-session map 读取失败，重置', err);
      return {};
    }
  }

  async hydrateWorldSessionMap() {
    try {
      const kv = await safeInvoke('load_kv', { name: this.getWorldSessionMapKey() });
      if (kv && typeof kv === 'object' && !kv._tooLarge && Object.keys(kv).length) {
        this.worldSessionMap = kv;
        try {
          localStorage.setItem(this.getWorldSessionMapKey(), JSON.stringify(kv));
        } catch (err) {
          logger.warn('world-session map hydrate -> localStorage failed', err);
        }
        // 切换当前 session 的世界书
        if (this.activeSessionId && kv[this.activeSessionId]) {
          this.currentWorldIds = this.normalizeWorldIds(kv[this.activeSessionId]);
          this.currentWorldId = this.currentWorldIds[0] || null;
          this.emitWorldInfoChanged();
        }
        logger.debug('world-session map hydrated from disk');
      }
    } catch (err) {
      logger.debug('world-session map 磁盘加载失败（可能非 Tauri）', err);
    }
  }

  async hydrateGlobalWorldId() {
    try {
      const plural = await safeInvoke('load_kv', { name: this.getGlobalWorldIdsKey() });
      if (Array.isArray(plural) || typeof plural === 'string') {
        this.globalWorldIds = this.normalizeStoredGlobalWorldIds(plural);
        this.globalWorldId = this.globalWorldIds[0] || null;
        try {
          localStorage.setItem(this.getGlobalWorldIdsKey(), JSON.stringify(this.globalWorldIds));
          localStorage.setItem(this.getGlobalWorldIdKey(), this.globalWorldId || '');
        } catch {}
        return;
      }
      const kv = await safeInvoke('load_kv', { name: this.getGlobalWorldIdKey() });
      if (typeof kv === 'string') {
        this.globalWorldIds = this.normalizeStoredGlobalWorldIds(kv);
        this.globalWorldId = this.globalWorldIds[0] || null;
        this.persistGlobalWorldId();
        return;
      }
      const legacy = await safeInvoke('load_kv', { name: this.getLegacyScopedGlobalWorldIdKey() });
      if (typeof legacy === 'string') {
        this.globalWorldIds = this.normalizeStoredGlobalWorldIds(legacy);
        this.globalWorldId = this.globalWorldIds[0] || null;
        this.persistGlobalWorldId();
      }
    } catch (err) {
      logger.debug('global world id 磁盘加载失败（可能非 Tauri）', err);
    }
  }

  async hydrateWorldGlobalSettings() {
    try {
      const kv = await safeInvoke('load_kv', { name: this.getWorldGlobalSettingsKey() });
      if (kv && typeof kv === 'object' && !kv._tooLarge) {
        this.worldGlobalSettings = this.normalizeWorldGlobalSettings(kv);
        localStorage.setItem(this.getWorldGlobalSettingsKey(), JSON.stringify(this.worldGlobalSettings));
        return;
      }
      const legacy = await safeInvoke('load_kv', { name: this.getLegacyScopedWorldGlobalSettingsKey() });
      if (legacy && typeof legacy === 'object' && !legacy._tooLarge) {
        this.worldGlobalSettings = this.normalizeWorldGlobalSettings(legacy);
        this.persistWorldGlobalSettings();
      }
    } catch (err) {
      logger.debug('global world settings 磁盘加载失败（可能非 Tauri）', err);
    }
  }

  persistWorldSessionMap() {
    try {
      localStorage.setItem(this.getWorldSessionMapKey(), JSON.stringify(this.worldSessionMap || {}));
    } catch (err) {
      logger.warn('world-session map persist -> localStorage failed', err);
    }
    safeInvoke('save_kv', { name: this.getWorldSessionMapKey(), data: this.worldSessionMap || {} }).catch(() => {});
  }

  getWorldSessionMap() {
    return this.worldSessionMap || {};
  }

  replaceWorldSessionMap(worldSessionMap = {}) {
    this.worldSessionMap = worldSessionMap && typeof worldSessionMap === 'object' && !Array.isArray(worldSessionMap)
      ? worldSessionMap
      : {};
    this.persistWorldSessionMap();
    const activeSessionId = String(this.getActiveSessionId?.() || this.activeSessionId || '').trim();
    this.currentWorldIds = activeSessionId ? this.normalizeWorldIds(this.worldSessionMap?.[activeSessionId]) : [];
    this.currentWorldId = this.currentWorldIds[0] || null;
  }

  renameWorldSessionMapEntry(fromSessionId = '', toSessionId = '') {
    const from = String(fromSessionId || '').trim();
    const to = String(toSessionId || '').trim();
    if (!from || !to || !Object.prototype.hasOwnProperty.call(this.worldSessionMap || {}, from)) return false;
    this.worldSessionMap[to] = this.worldSessionMap[from];
    delete this.worldSessionMap[from];
    this.persistWorldSessionMap();
    return true;
  }

  deleteWorldSessionMapEntry(sessionId = '') {
    const sid = String(sessionId || '').trim();
    if (!sid || !Object.prototype.hasOwnProperty.call(this.worldSessionMap || {}, sid)) return false;
    delete this.worldSessionMap[sid];
    this.persistWorldSessionMap();
    return true;
  }

  persistGlobalWorldId() {
    this.globalWorldIds = Array.from(new Set(this.normalizeWorldIds(
      Array.isArray(this.globalWorldIds) ? this.globalWorldIds : this.globalWorldId,
    )));
    this.globalWorldId = this.globalWorldIds[0] || null;
    try {
      localStorage.setItem(this.getGlobalWorldIdsKey(), JSON.stringify(this.globalWorldIds));
      localStorage.setItem(this.getGlobalWorldIdKey(), this.globalWorldId || '');
    } catch {}
    safeInvoke('save_kv', { name: this.getGlobalWorldIdsKey(), data: this.globalWorldIds }).catch(() => {});
    // 同步旧单值键，确保降级到旧版本时仍可读取第一本全局世界书。
    safeInvoke('save_kv', { name: this.getGlobalWorldIdKey(), data: String(this.globalWorldId || '') }).catch(() => {});
  }

  persistWorldGlobalSettings() {
    try {
      localStorage.setItem(this.getWorldGlobalSettingsKey(), JSON.stringify(this.worldGlobalSettings || {}));
    } catch {}
    safeInvoke('save_kv', { name: this.getWorldGlobalSettingsKey(), data: this.worldGlobalSettings || {} }).catch(() => {});
  }

  /**
   * 初始化桥接层
   */
  async init() {
    try {
      logger.debug('初始化 AppBridge...');

      // 加载配置
      await this.presets.ready;
      await this.regex.ready;
      try {
        await chatFcLocalCapabilityStore.load();
      } catch (error) {
        logger.warn('本地 FC 兼容规则加载失败，继续使用同步镜像或内建目录', error);
      }
      try {
        await chatStructuredRouteEvidenceStore.load();
      } catch (error) {
        logger.warn('本机结构化路由证据加载失败，本轮从未观察状态继续', error);
      }
      this.worldStore.prewarm?.();
      this.scheduleDeferredWorldBootstrap();
      let config = await this.config.load();
      // 注意：不要在启动时强制用“预设绑定连接”覆盖用户最后一次使用的连接配置。
      // 预设绑定仅在用户切换预设时应用（由 preset-panel 调用 applyBoundConfigIfAny），否则会导致
      // “明明保存/选择了 Deepseek，重启又回到默认配置”的问题。

      // 初始化 LLM 客户端
      if (canInitClient(config)) {
        this.client = new LLMClient(config);
        logger.debug(`LLM 客户端初始化成功 (provider: ${config.provider})`);
      } else {
        logger.warn('未配置 API 认证信息，请先配置');
      }

      this.initialized = true;
      logger.debug('AppBridge 初始化完成');

      return true;
    } catch (error) {
      logger.error('AppBridge 初始化失败:', error);
      return false;
    }
  }

  /**
   * 检查是否已配置
   */
  isConfigured() {
    const config = this.config.get();
    return Boolean(canInitClient(config));
  }

  getConfig() {
    return this.config?.get?.() || {};
  }

  async loadConfig() {
    const loaded = await this.config?.load?.();
    return this.config?.get?.() || loaded || {};
  }

  async reloadConfig() {
    const reloaded = await this.config?.reload?.();
    return this.config?.get?.() || reloaded || {};
  }

  async ensureConfigStores() {
    return await this.config?.ensureStores?.();
  }

  getConfigProfiles() {
    return this.config?.getProfiles?.() || [];
  }

  getConfigProfileById(profileId) {
    return this.config?.getProfileById?.(profileId) || null;
  }

  getActiveConfigProfile() {
    return this.config?.getActiveProfile?.() || null;
  }

  getActiveConfigProfileId() {
    return this.config?.getActiveProfileId?.() || '';
  }

  async setActiveConfigProfile(profileId) {
    return await this.config?.setActiveProfile?.(profileId);
  }

  async createConfigProfile(name, config = {}) {
    return await this.config?.createProfile?.(name, config);
  }

  setChatRuntimeConfig(config = {}) {
    const runtime = config && typeof config === 'object' ? config : {};
    this.config?.set?.(runtime);
    this.client = canInitClient(runtime) ? new LLMClient(runtime) : null;
    return {
      ok: true,
      configured: Boolean(this.client),
      clientReady: Boolean(this.client),
    };
  }

  async resolveRequestRuntimeConfig(presetContext = {}) {
    const globalConfig = this.config?.get?.() || {};
    const resolved = resolveRequestConfigProfileId({
      presetStore: this.presets,
      sessionId: presetContext?.sessionId || '',
      uiMode: presetContext?.uiMode || '',
      taskType: presetContext?.taskType || '',
    });
    const profileId = String(resolved?.profileId || '').trim();
    if (!profileId) {
      return {
        config: globalConfig,
        client: this.client,
        profileId: String(this.config?.getActiveProfileId?.() || '').trim(),
        bindingSource: 'global',
        bound: false,
        sessionId: resolved.sessionId,
        uiMode: resolved.uiMode,
      };
    }

    const activeProfileId = String(this.config?.getActiveProfileId?.() || '').trim();
    if (activeProfileId && activeProfileId === profileId) {
      return {
        config: globalConfig,
        client: this.client || (canInitClient(globalConfig) ? new LLMClient(globalConfig) : null),
        profileId,
        bindingSource: resolved.source,
        bound: true,
        sessionId: resolved.sessionId,
        uiMode: resolved.uiMode,
      };
    }

    const runtime = await this.config?.getRuntimeConfigByProfileId?.(profileId);
    if (!runtime || typeof runtime !== 'object') {
      const e = new Error(`绑定的 API 配置不存在：${profileId}`);
      e.code = 'BOUND_CONFIG_NOT_FOUND';
      e.profileId = profileId;
      throw e;
    }
    const client = canInitClient(runtime) ? new LLMClient(runtime) : null;
    if (!client) {
      const label = String(this.config?.getProfileById?.(profileId)?.name || profileId).trim();
      const e = new Error(`绑定的 API 配置「${label}」不完整，请检查密钥、模型和地址`);
      e.code = 'BOUND_CONFIG_INVALID';
      e.profileId = profileId;
      throw e;
    }
    return {
      config: runtime,
      client,
      profileId,
      bindingSource: resolved.source,
      bound: true,
      sessionId: resolved.sessionId,
      uiMode: resolved.uiMode,
    };
  }

  /**
   * 切换当前会话（影响世界书选中）
   */
  getActiveSessionId() {
    return String(this.activeSessionId || '').trim();
  }

  setActiveSession(sessionId = 'default') {
    const prevSessionId = this.activeSessionId;
    this.activeSessionId = sessionId;
    this.currentWorldIds = this.normalizeWorldIds(this.worldSessionMap[sessionId]);
    this.currentWorldId = this.currentWorldIds[0] || null;
    this.syncWorldRegexBindings?.();
    this.emitWorldInfoChanged({ sessionId: this.activeSessionId });
    try {
      const buildSessionPayload = (sid) => {
        const id = String(sid || '').trim();
        if (!id) return null;
        const contact = this.contactsStore?.getContact?.(id) || null;
        const name = contact?.name || id;
        const isGroup = Boolean(contact?.isGroup) || id.startsWith('group:');
        return { id, name, isGroup };
      };
      const payload = {
        oldSession: buildSessionPayload(prevSessionId),
        newSession: buildSessionPayload(sessionId),
      };
      const traceDetails = {
        oldSessionId: payload.oldSession?.id || '',
        newSessionId: payload.newSession?.id || '',
        oldIsGroup: payload.oldSession?.isGroup === true,
        newIsGroup: payload.newSession?.isGroup === true,
      };
      const recordTraceEvent = event => recordDebugTraceEvent(this, event);
      const runtime = this.pluginRuntime;
      if (runtime) {
        dispatchRuntimeHookLifecycleEvent({
          runtime,
          runtimeLabel: 'plugin',
          hookName: 'session.changed',
          payload,
          sessionId: payload.newSession?.id || '',
          details: traceDetails,
          logger,
          warningMessage: 'plugin session.changed failed',
          recordTraceEvent,
        });
      }
      const scriptRuntime = this.scriptRuntime;
      if (scriptRuntime) {
        dispatchRuntimeHookLifecycleEvent({
          runtime: scriptRuntime,
          runtimeLabel: 'script',
          hookName: 'session.changed',
          payload,
          sessionId: payload.newSession?.id || '',
          details: traceDetails,
          logger,
          warningMessage: 'script session.changed failed',
          recordTraceEvent,
        });
      }
    } catch (err) {
      logger.debug('plugin session.changed dispatch skipped', err);
    }
  }

  getRegexContext(options = {}) {
    const sid = String(options?.sessionId || this.activeSessionId || '').trim();
    const uiModeRaw = String(
      options?.uiMode
      || this.getUiModeContext?.()
      || '',
    ).trim().toLowerCase();
    const uiMode = normalizeBridgePresetUiMode(uiModeRaw, { sessionId: sid });
    const activePresets = (() => {
      const out = {};
      const presetTypes = ['sysprompt', 'context', 'instruct', 'openai', 'reasoning'];
      for (const type of presetTypes) {
        if (this.presets?.getEnabled?.(type) === false) continue;
        const resolvedId = String(
          this.presets?.getResolvedActiveId?.(type, { sessionId: sid, uiMode })?.presetId
          || '',
        ).trim();
        if (!resolvedId) continue;
        out[type] = resolvedId;
      }
      return out;
    })();
    const resolvedWorldState = this.getResolvedWorldState(sid, options);
    const worldIds = Array.isArray(resolvedWorldState?.worldIds) ? resolvedWorldState.worldIds : [];
    let localVars = {};
    let globalVars = {};
    const variableRuntimeEnabled = this.isVariableRuntimeEnabled?.(sid) !== false;
    if (variableRuntimeEnabled) {
      try {
        localVars = this.chatStore?.listVariables?.(sid) || {};
      } catch {}
      try {
        globalVars = this.chatStore?.listGlobalVariables?.() || {};
      } catch {}
    }
    const isShared = typeof this.isSharedVariableSession === 'function'
      ? Boolean(this.isSharedVariableSession(sid))
      : false;
    const baseVars = isShared ? globalVars : localVars;
    return {
      sessionId: sid,
      uiMode,
      worldId: String(this.currentWorldId || '').trim() || worldIds[0] || '',
      worldIds,
      activePresets,
      macroVars: buildMacroVariableContext({
        baseVars,
        globalVars,
        localVars,
        topLevelMode: isShared ? 'base' : 'merged',
      }),
    };
  }

  async syncPresetRegexBindings() {
    try {
      await this.presets?.ready;
      await this.regex?.ready;
      const presetState = this.presets?.getState?.() || {};
      const active = (() => {
        const activePresets = presetState?.active || {};
        const enabled = presetState?.enabled || {};
        const out = {};
        for (const [type, id] of Object.entries(activePresets)) {
          if (!id) continue;
          if (enabled && enabled[type] === false) continue;
          out[type] = id;
        }
        return out;
      })();
      const changed = await this.regex.syncPresetBindings?.(active);
      if (changed) {
        window.dispatchEvent(new CustomEvent('regex-changed'));
      }
      return Boolean(changed);
    } catch {
      return false;
    }
  }

  async syncWorldRegexBindings() {
    try {
      await this.regex?.ready;
      const worldIds = this.getResolvedWorldState(this.activeSessionId).worldIds;
      const changed = await this.regex?.syncWorldBindings?.(worldIds);
      if (changed) {
        window.dispatchEvent(new CustomEvent('regex-changed'));
      }
      return Boolean(changed);
    } catch {
      return false;
    }
  }

  applyInputRegex(text, { isEdit = false, depth } = {}) {
    try {
      return this.regex.apply(text, this.getRegexContext(), regex_placement.USER_INPUT, {
        isMarkdown: false,
        isPrompt: false,
        isEdit: Boolean(isEdit),
        depth,
      });
    } catch {
      return String(text ?? '');
    }
  }

  applyInputStoredRegex(text, opts) {
    return this.applyInputRegex(text, opts);
  }

  applyInputDisplayRegex(text, { isEdit = false, depth } = {}) {
    try {
      return this.regex.apply(text, this.getRegexContext(), regex_placement.USER_INPUT, {
        isMarkdown: true,
        isPrompt: false,
        isEdit: Boolean(isEdit),
        depth,
      });
    } catch {
      return String(text ?? '');
    }
  }

  /**
   * Direct (non-ephemeral) scripts: alter stored chat content irreversibly
   * - ST semantics: neither "Alter Chat Display" nor "Alter Outgoing Prompt" checked
   */
  applyOutputStoredRegex(text, { isEdit = false, depth } = {}) {
    try {
      return this.regex.apply(text, this.getRegexContext(), regex_placement.AI_OUTPUT, {
        isMarkdown: false,
        isPrompt: false,
        isEdit: Boolean(isEdit),
        depth,
      });
    } catch {
      return String(text ?? '');
    }
  }

  /**
   * Ephemeral display scripts: alter what user sees, without changing stored chat text
   */
  applyOutputDisplayRegex(text, { isEdit = false, depth } = {}) {
    try {
      return this.regex.apply(text, this.getRegexContext(), regex_placement.AI_OUTPUT, {
        isMarkdown: true,
        isPrompt: false,
        isEdit: Boolean(isEdit),
        depth,
      });
    } catch {
      return String(text ?? '');
    }
  }

  /**
   * Compatibility: raw -> stored -> display
   */
  applyOutputRegex(text) {
    const stored = this.applyOutputStoredRegex(text);
    return this.applyOutputDisplayRegex(stored);
  }

  applyReasoningStoredRegex(text, { isEdit = false, depth } = {}) {
    try {
      return this.regex.apply(text, this.getRegexContext(), regex_placement.REASONING, {
        isMarkdown: false,
        isPrompt: false,
        isEdit: Boolean(isEdit),
        depth,
      });
    } catch {
      return String(text ?? '');
    }
  }

  applyReasoningDisplayRegex(text, { isEdit = false, depth } = {}) {
    try {
      return this.regex.apply(text, this.getRegexContext(), regex_placement.REASONING, {
        isMarkdown: true,
        isPrompt: false,
        isEdit: Boolean(isEdit),
        depth,
      });
    } catch {
      return String(text ?? '');
    }
  }

  getRequestPresetContext(context = {}) {
    const sessionId = String(context?.session?.id || this.activeSessionId || '').trim();
    return {
      sessionId,
      uiMode: normalizeBridgePresetUiMode(
        context?.meta?.uiMode
        || context?.uiMode
        || this.getUiModeContext?.()
        || '',
        {
          sessionId,
          taskType: context?.task?.type,
        },
      ),
    };
  }

  buildProviderRequestDirectives(context = {}, presetContext = {}, runtimeConfigOverride = null) {
    const cfg = runtimeConfigOverride && typeof runtimeConfigOverride === 'object'
      ? runtimeConfigOverride
      : (this.config?.get?.() || {});
    if (String(cfg?.provider || '').trim().toLowerCase() === 'custom') {
      return {};
    }
    if (!isDeepSeekApiRequest({ provider: cfg?.provider, model: cfg?.model, baseUrl: cfg?.baseUrl })) {
      return {};
    }
    const state = this.presets?.getState?.();
    if (!state?.enabled?.openai) return {};
    const openp = this.presets?.getResolvedActive?.('openai', presetContext || {})?.preset || null;
    if (!openp || typeof openp !== 'object') return {};

    const uiMode = normalizeBridgePresetUiMode(presetContext?.uiMode, {
      sessionId: presetContext?.sessionId || '',
    });
    const responseTarget = resolvePresetReplyTarget(openp, uiMode, context?.meta?.responseTarget);
    if (responseTarget === 'user') return {};

    const continuation = context?.meta?.assistantContinuation;
    if (continuation?.enabled === true) {
      if (openp.continue_prefill !== true) return {};
      const prefixBase = typeof continuation.prefix === 'string' ? continuation.prefix : '';
      if (!prefixBase) return {};
      const postfixRaw = typeof openp?.continue_postfix === 'string' ? openp.continue_postfix : ' ';
      const macroContext = {
        sessionId: presetContext?.sessionId || '',
        uiMode,
        user: context?.user?.name || 'user',
        char: context?.character?.name || 'assistant',
        group: context?.group?.name || context?.character?.name || 'assistant',
        members: Array.isArray(context?.group?.memberNames) ? context.group.memberNames.map(String).filter(Boolean).join(',') : '',
        lastUserMessage: String(context?.meta?.overrideLastUserMessage || context?.meta?.rawUserMessage || ''),
        useGlobalVariables: context?.meta?.useGlobalVariables === true,
        macroVariableState: context?.meta?.macroVariableState,
      };
      let postfix = postfixRaw;
      try {
        postfix = this.processTextMacros(postfixRaw, macroContext);
      } catch {}
      return {
        deepseekPrefix: {
          mode: 'continue',
          prefix: `${prefixBase}${String(postfix ?? '')}`,
        },
      };
    }

    const assistantPrefillRaw = String(openp?.assistant_prefill || '');
    if (!assistantPrefillRaw.trim()) return {};
    const macroContext = {
      sessionId: presetContext?.sessionId || '',
      uiMode,
      user: context?.user?.name || 'user',
      char: context?.character?.name || 'assistant',
      group: context?.group?.name || context?.character?.name || 'assistant',
      members: Array.isArray(context?.group?.memberNames) ? context.group.memberNames.map(String).filter(Boolean).join(',') : '',
      lastUserMessage: String(context?.meta?.overrideLastUserMessage || context?.meta?.rawUserMessage || ''),
      useGlobalVariables: context?.meta?.useGlobalVariables === true,
      macroVariableState: context?.meta?.macroVariableState,
    };
    let assistantPrefill = assistantPrefillRaw;
    try {
      assistantPrefill = this.processTextMacros(assistantPrefillRaw, macroContext);
    } catch {}
    if (!String(assistantPrefill || '').trim()) return {};
    return {
      deepseekPrefix: {
        mode: 'assistant_prefill',
        prefix: String(assistantPrefill),
      },
    };
  }

  mergeAssistantPrefillResponse(prefix, response) {
    return mergeDeepSeekPrefillResponse(prefix, response);
  }

  async *applyAssistantPrefillToStream(stream, prefix = '') {
    yield* applyDeepSeekPrefillToStream(stream, prefix);
  }

  // Phase B：取走本次生成的真实 usage 并清空（consume-once），供 finalize 消息挂到 meta.usage。
  // 只挂首条：一次生成 emit 多条时，usage 属于整次生成，重复挂会误导每条的计量。
  consumeLastGenerationUsage() {
    const usage = this.lastGenerationUsage || null;
    if (usage && this.lastRequest?.responseDiagnostics) {
      this.lastRequest.responseDiagnostics = {
        ...this.lastRequest.responseDiagnostics,
        usagePersistenceTarget: 'assistant_message',
      };
    }
    this.lastGenerationUsage = null;
    return usage;
  }

  consumeLastGenerationSources() {
    const sources = Array.isArray(this.lastGenerationSources)
      ? this.lastGenerationSources.slice()
      : null;
    this.lastGenerationSources = null;
    return sources?.length ? sources : null;
  }

  async finalizeChatStructuredEvidence({ requestId = '', committed = false } = {}) {
    let result;
    try {
      result = await this.chatStructuredEvidenceCommitRuntime.finalize({
        requestId,
        committed,
      });
    } catch (error) {
      logger.warn('结构化路由成功证据保存失败', error);
      return { recorded: false, reason: 'evidence_store_failed', transition: null };
    } finally {
      chatStructuredRouteEvidenceStore.releaseHalfOpenRequest(requestId);
    }
    const transition = result?.transition;
    if (this.lastRequest?.requestId === String(requestId || '').trim() && transition?.cell) {
      this.lastRequest.phoneReplyTransport = {
        ...(this.lastRequest.phoneReplyTransport || {}),
        evidenceStatus: String(transition.cell.health?.status || ''),
        evidenceStrictSuccessCount: Number(transition.cell.health?.strictSuccessCount || 0),
        evidenceAction: String(transition.action || ''),
      };
    }
    if (transition?.action === 'circuit_closed') {
      try {
        window.dispatchEvent(new CustomEvent('chatapp-phone-structured-route-status', {
          detail: {
            state: 'circuit_closed',
            sessionId: String(this.lastRequest?.session?.id || ''),
            requestId: String(requestId || ''),
            evidenceKey: String(transition.cell?.key || ''),
            circuitEpoch: Number(transition.cell?.health?.circuitEpoch || 0),
          },
        }));
      } catch {}
    }
    return result;
  }

  getTokenCalibration(provider = '', model = '') {
    return tokenCalibrationStore.get(provider, model);
  }

  getActiveTokenCalibration() {
    const config = this.config?.get?.() || {};
    return this.getTokenCalibration(config?.provider, config?.model);
  }

  /**
   * 生成 AI 回复
   * @param {string} userMessage - 用户消息
   * @param {Object} context - 上下文（角色设定、历史消息等）
   * @returns {Promise<string>|AsyncGenerator<string>} 回复内容或流
   */
  async generate(userMessage, context = {}) {
    const requestContext = captureRequestContext(context?.meta?.requestContext || {
      scopeId: this.scopeId,
      sessionId: context?.session?.id || this.activeSessionId,
      archiveId: this.chatStore?.getCurrentArchiveId?.(context?.session?.id || this.activeSessionId),
    });
    const previewOnly = context?.meta?.previewOnly === true;
    const phoneStructuredPreviewCallback = !previewOnly
      && typeof context?.meta?.onPhoneStructuredPreview === 'function'
      ? context.meta.onPhoneStructuredPreview
      : null;
    let previewBuildPromise = null;
    let releasePreviewBuild = null;
    if (previewOnly) {
      while (this.previewBuildPromise) await this.previewBuildPromise;
      if (this.isGenerating) {
        throw new Error('正在生成中，请稍候...');
      }
      previewBuildPromise = new Promise(resolve => { releasePreviewBuild = resolve; });
      this.previewBuildPromise = previewBuildPromise;
    } else {
      while (this.previewBuildPromise) await this.previewBuildPromise;
      if (this.isGenerating) {
        throw new Error('正在生成中，请稍候...');
      }
      this.isGenerating = true;
    }
    const generationToken = previewOnly ? 0 : (Number(this.activeGenerationToken) || 0) + 1;
    if (!previewOnly) this.activeGenerationToken = generationToken;
    const abortController = new AbortController();
    if (!previewOnly) {
      this.abortController = abortController;
      this.abortReason = '';
    }
    const nativeRequestId = `http_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
    if (!previewOnly) this.activeNativeRequestId = nativeRequestId;
    let streaming = false;
    const releaseGenerationLock = () => {
      if (previewOnly) {
        if (this.previewBuildPromise === previewBuildPromise) this.previewBuildPromise = null;
        const release = releasePreviewBuild;
        releasePreviewBuild = null;
        release?.();
        return;
      }
      if (this.activeGenerationToken === generationToken) {
        this.isGenerating = false;
        if (this.abortController === abortController) {
          this.abortController = null;
        }
        this.abortReason = '';
        this.activeGenerationToken = 0;
        if (this.activeNativeRequestId === nativeRequestId) {
          this.activeNativeRequestId = '';
        }
      }
    };

    const previousLastMemoryPlan = this.lastMemoryPlan;
    const previousLastRequest = this.lastRequest;
    const previousLastGenerationUsage = this.lastGenerationUsage;
    const previousLastGenerationSources = this.lastGenerationSources;
    const previousLastWorldInjectionDebug = this.lastWorldInjectionDebug;
    const previousLastDeepSeekFormatDebug = this.lastDeepSeekFormatDebug;
    const previousLastPhoneFormatTransportPlan = this.lastPhoneFormatTransportPlan;
    const previousLastPromptSegmentDebug = this.lastPromptSegmentDebug;
    const previousActiveInputBudgetPlan = this.activeInputBudgetPlan;
    const previousActiveTokenEstimateMode = this.activeTokenEstimateMode;
    const previewSessionId = String(context?.session?.id || this.activeSessionId || 'default').trim() || 'default';
    const hadPreviousPromptCacheDebug = this.lastPromptCacheDebugBySession?.has?.(previewSessionId) === true;
    const previousPromptCacheDebug = this.lastPromptCacheDebugBySession?.get?.(previewSessionId);
    try {
      if (!this.initialized) {
        await this.init();
      }
      if (this.worldStore?.ready) {
        await this.worldStore.ready;
      }
      if (!this.worldBootstrapCompleted) {
        await this.runDeferredWorldBootstrap();
      }
      await this.ensureWorldsForContext(context);

      if (!previewOnly && !this.isConfigured()) {
        throw new Error('请先配置 API 信息');
      }

      if (!previewOnly && typeof navigator !== 'undefined' && !navigator.onLine) {
        throw new Error('当前离线，请连接网络后再试');
      }

      const originalInput = userMessage;
      // ST semantics:
      // - direct scripts (non-ephemeral) may alter stored chat content
      // - promptOnly scripts apply to outgoing prompt only
      const ctx = this.getRegexContext();
      const skipInputRegex = context?.meta?.skipInputRegex === true;
      const directInput = skipInputRegex
        ? userMessage
        : this.regex.apply(userMessage, ctx, regex_placement.USER_INPUT, {
            isMarkdown: false,
            isPrompt: false,
            isEdit: false,
            depth: 0,
          });
      let promptInput = skipInputRegex
        ? userMessage
        : this.regex.apply(userMessage, ctx, regex_placement.USER_INPUT, {
            // Product requirement: as long as enabled, input regex should apply to outgoing prompt.
            // So, include markdownOnly scripts too when building outgoing prompt.
            isMarkdown: true,
            isPrompt: true,
            isEdit: false,
            depth: 0,
          });
      const sanitizedContextMeta = {
        ...(context?.meta || {}),
      };
      delete sanitizedContextMeta.onPhoneStructuredPreview;
      let nextContext = {
        ...(context || {}),
        meta: {
          ...sanitizedContextMeta,
          rawUserMessage: originalInput,
          userMessageProcessed: true,
        },
      };
      let preliminaryConfig = this.config?.get?.() || {};
      try {
        const preliminaryRuntime = await this.resolveRequestRuntimeConfig(
          this.getRequestPresetContext(nextContext),
        );
        preliminaryConfig = preliminaryRuntime?.config || preliminaryConfig;
      } catch {}
      const preliminaryCalibration = this.getTokenCalibration(
        preliminaryConfig?.provider,
        preliminaryConfig?.model,
      );
      const preliminaryTokenMode = {
        mode: 'rough',
        coefficient: preliminaryCalibration.coefficient,
      };
      this.activeTokenEstimateMode = preliminaryTokenMode;
      nextContext.meta = {
        ...(nextContext.meta || {}),
        tokenEstimateCalibration: {
          ...preliminaryCalibration,
          provider: String(preliminaryConfig?.provider || preliminaryCalibration.provider || ''),
          model: String(preliminaryConfig?.model || preliminaryCalibration.model || ''),
        },
      };
      try {
        let memoryPlan = await this.buildMemoryPromptPlan(nextContext);
        if (!memoryPlan?.budget) {
          const inputBudgetContext = nextContext?.meta?.inputBudgetContext || {};
          const worldSettings = this.getWorldGlobalSettings?.() || this.worldGlobalSettings || {};
          const globalSettings = appSettings.get();
          const fallbackEnvelope = resolveMemoryBudgetEnvelope({
            settings: globalSettings,
            maxContextTokens: inputBudgetContext?.maxContextTokens,
            maxOutputTokens: inputBudgetContext?.maxOutputTokens,
            place: nextContext?.meta?.uiMode,
            worldContextPercent: worldSettings?.contextPercent,
            worldBudgetCap: worldSettings?.budgetCap,
            demands: {
              state: 0,
              recent: estimatePromptMessagesTokens(nextContext?.history || [], preliminaryTokenMode),
              mid: 0,
              far: 0,
              recall: 0,
            },
          });
          memoryPlan = {
            ...(memoryPlan || {}),
            budget: {
              mode: fallbackEnvelope?.mode || 'token',
              place: fallbackEnvelope?.place || 'chat',
              inputBudgetTokens: fallbackEnvelope?.inputBudgetTokens ?? null,
              outputReserveTokens: fallbackEnvelope?.input?.maxOutputTokens ?? null,
              safetyReserveTokens: fallbackEnvelope?.input?.safetyReserveTokens ?? 512,
              fixedReserveTokens: fallbackEnvelope?.fixedReserveTokens ?? 0,
              worldBudgetTokens: fallbackEnvelope?.worldBudgetTokens ?? null,
              distributableTokens: fallbackEnvelope?.distributableTokens ?? null,
              ratios: fallbackEnvelope?.allocation?.ratios || null,
              baseQuotas: fallbackEnvelope?.allocation?.baseQuotas || null,
              allocations: fallbackEnvelope?.allocation?.allocations || null,
              overQuotaSegments: fallbackEnvelope?.allocation?.overQuotaSegments || [],
            },
          };
        }
        const recentQuota = resolveRecentHistoryQuota(memoryPlan?.budget?.allocations?.recent);
        if (
          recentQuota !== null
          && Array.isArray(nextContext?.history)
        ) {
          const originalHistory = nextContext.history;
          const firstPass = limitHistoryByTokenBudget(originalHistory, {
            inputBudgetTokens: recentQuota,
            tokenMode: preliminaryTokenMode,
          });
          let finalHistory = firstPass;
          let coverageLine = null;
          let oldestRecentTurn = null;
          let protectedMessageIndexes = [];
          if (memoryPlan?.enabled) {
            const totalTurns = Math.max(
              0,
              Math.trunc(Number(memoryPlan?.coverageSource?.totalTurns)) || 0,
            );
            const historyLastTurn = Math.max(
              0,
              totalTurns - (nextContext?.meta?.suppressPendingUserTurn === true ? 0 : 1),
            );
            const turnMap = mapHistoryMessagesToTurns(originalHistory, {
              lastTurn: historyLastTurn,
            });
            const keptTurns = firstPass.stats.keptOriginalIndexes
              .map(index => turnMap[index]?.turn)
              .filter(turn => Number.isFinite(turn) && turn > 0);
            oldestRecentTurn = keptTurns.length ? Math.min(...keptTurns) : historyLastTurn + 1;
            coverageLine = buildMemoryCoverageLine({
              summaryRows: memoryPlan?.coverageSource?.rows || [],
              fromTurn: 1,
              toTurn: Math.max(0, oldestRecentTurn - 1),
            });
            protectedMessageIndexes = resolveCoverageProtectedHistoryIndexes({
              history: originalHistory,
              holes: coverageLine.holes,
              lastTurn: historyLastTurn,
            });
            if (protectedMessageIndexes.length) {
              finalHistory = limitHistoryByTokenBudget(originalHistory, {
                inputBudgetTokens: recentQuota,
                protectedMessageIndexes,
                tokenMode: preliminaryTokenMode,
              });
            }
          }
          nextContext = {
            ...(nextContext || {}),
            history: finalHistory.messages,
          };
          memoryPlan = {
            ...memoryPlan,
            historyBudgetStats: finalHistory.stats,
            coverageLine: coverageLine
              ? {
                  ...coverageLine,
                  oldestRecentTurn,
                  protectedMessageCount: protectedMessageIndexes.length,
                }
              : null,
          };
        }
        this.lastMemoryPlan = memoryPlan;
        this.activeInputBudgetPlan = memoryPlan?.budget || null;
        if (memoryPlan?.enabled && (memoryPlan.dataPromptText || memoryPlan.guidePromptText || memoryPlan.dynamicProfileDebug)) {
          const nextMeta = {
            ...(nextContext.meta || {}),
          };
          if (memoryPlan.dataPromptText) {
            nextMeta.memoryPrompt = {
              content: memoryPlan.dataPromptText,
              position: memoryPlan.position,
              depth: memoryPlan.injectDepth,
            };
          }
          if (memoryPlan.guidePromptText) {
            nextMeta.memoryGuidePrompt = {
              content: memoryPlan.guidePromptText,
              position: memoryPlan.guidePosition || 'before_latest_user',
              depth: memoryPlan.guideInjectDepth,
            };
          }
          if (memoryPlan.dynamicProfileDebug) {
            nextMeta.dynamicProfileDebug = memoryPlan.dynamicProfileDebug;
          }
          nextContext.meta = nextMeta;
        }
      } catch (err) {
        logger.warn('memory prompt plan failed', err);
      }
      const recordPromptHookTraceEvent = event => recordDebugTraceEvent(this, event);
      const scriptRuntime = this.scriptRuntime;
      if (!previewOnly && scriptRuntime && nextContext?.meta?.skipScripts !== true) {
        const beforePromptInput = promptInput;
        const beforePromptContext = nextContext;
        const { result: updated } = await runRuntimeHookLifecycleEvent({
          runtime: scriptRuntime,
          runtimeLabel: 'script',
          hookName: 'prompt.before_build',
          payload: {
            input: promptInput,
            context: nextContext,
          },
          sessionId: String(nextContext?.session?.id || this.activeSessionId || '').trim(),
          details: {
            inputLength: String(promptInput || '').length,
            hasContext: Boolean(nextContext),
          },
          finishDetails: result => ({
            hasInputOverride: typeof result?.input === 'string',
            inputChanged: typeof result?.input === 'string' && result.input !== beforePromptInput,
            hasContextOverride: Boolean(result?.context && typeof result.context === 'object'),
            contextChanged: Boolean(result?.context && typeof result.context === 'object' && result.context !== beforePromptContext),
          }),
          logger,
          warningMessage: 'script prompt.before_build failed',
          recordTraceEvent: recordPromptHookTraceEvent,
        });
        if (updated && typeof updated === 'object') {
          if (typeof updated.input === 'string') promptInput = updated.input;
          if (updated.context && typeof updated.context === 'object') nextContext = updated.context;
        }
      }
      const pluginRuntime = this.pluginRuntime;
      if (!previewOnly && pluginRuntime) {
        const beforePromptInput = promptInput;
        const beforePromptContext = nextContext;
        const { result: updated } = await runRuntimeHookLifecycleEvent({
          runtime: pluginRuntime,
          runtimeLabel: 'plugin',
          hookName: 'prompt.before_build',
          payload: {
            input: promptInput,
            context: nextContext,
          },
          sessionId: String(nextContext?.session?.id || this.activeSessionId || '').trim(),
          details: {
            inputLength: String(promptInput || '').length,
            hasContext: Boolean(nextContext),
          },
          finishDetails: result => ({
            hasInputOverride: typeof result?.input === 'string',
            inputChanged: typeof result?.input === 'string' && result.input !== beforePromptInput,
            hasContextOverride: Boolean(result?.context && typeof result.context === 'object'),
            contextChanged: Boolean(result?.context && typeof result.context === 'object' && result.context !== beforePromptContext),
          }),
          logger,
          warningMessage: 'plugin prompt.before_build failed',
          recordTraceEvent: recordPromptHookTraceEvent,
        });
        if (updated && typeof updated === 'object') {
          if (typeof updated.input === 'string') promptInput = updated.input;
          if (updated.context && typeof updated.context === 'object') nextContext = updated.context;
        }
      }
      if (previewOnly) {
        const macroVariableState = nextContext?.meta?.macroVariableState instanceof Map
          ? nextContext.meta.macroVariableState
          : new Map();
        nextContext = {
          ...(nextContext || {}),
          meta: {
            ...(nextContext?.meta || {}),
            macroVariableState,
          },
        };
      }
      const presetContext = this.getRequestPresetContext(nextContext);
      const requestRuntime = await this.resolveRequestRuntimeConfig(presetContext);
      const config = requestRuntime?.config || this.config.get();
      const requestCalibration = this.getTokenCalibration(config?.provider, config?.model);
      const requestTokenMode = {
        mode: 'rough',
        coefficient: requestCalibration.coefficient,
      };
      this.activeTokenEstimateMode = requestTokenMode;
      const requestClient = requestRuntime?.client || (canInitClient(config) ? new LLMClient(config) : null);
      if (!previewOnly && !requestClient) {
        throw new Error('请先配置 API 信息');
      }
      const privateChatProviderFcStatus = (() => {
        try {
          const action = this.debugUiRegistry?.actions?.getPrivateChatProviderFcExperimentStatus;
          return typeof action === 'function' ? action() : null;
        } catch {
          return null;
        }
      })();
      const phoneProviderFcRelease = resolveChatProviderFcRelease(config);
      const phoneStructuredRoutingRequested = privateChatProviderFcStatus?.enabled === true
        && !(previewOnly && nextContext?.meta?.previewForceLegacyText === true);
      const deferPhoneTransportLayers = phoneStructuredRoutingRequested
        && appSettings.get().traditionalModelOutputProtocolEnabled !== true
        && String(presetContext?.uiMode || '').trim().toLowerCase() !== 'rp';
      let messages = this.buildMessages(promptInput, nextContext, {
        requestConfig: config,
        deferPhoneTransportLayers,
        transportAnchorNamespace: nativeRequestId,
      });
      if (!previewOnly && scriptRuntime && nextContext?.meta?.skipScripts !== true) {
        const beforePrompt = messages;
        const { result: updated } = await runRuntimeHookLifecycleEvent({
          runtime: scriptRuntime,
          runtimeLabel: 'script',
          hookName: 'prompt.after_build',
          payload: {
            prompt: messages,
            context: nextContext,
          },
          sessionId: String(nextContext?.session?.id || this.activeSessionId || '').trim(),
          details: {
            promptCount: Array.isArray(messages) ? messages.length : 0,
            hasContext: Boolean(nextContext),
          },
          finishDetails: result => ({
            hasPromptOverride: Array.isArray(result?.prompt),
            promptChanged: Array.isArray(result?.prompt) && result.prompt !== beforePrompt,
            promptCount: Array.isArray(result?.prompt) ? result.prompt.length : undefined,
          }),
          logger,
          warningMessage: 'script prompt.after_build failed',
          recordTraceEvent: recordPromptHookTraceEvent,
        });
        if (updated && typeof updated === 'object' && Array.isArray(updated.prompt)) {
          messages = updated.prompt;
        }
      }
      if (!previewOnly && pluginRuntime) {
        const beforePrompt = messages;
        const { result: updated } = await runRuntimeHookLifecycleEvent({
          runtime: pluginRuntime,
          runtimeLabel: 'plugin',
          hookName: 'prompt.after_build',
          payload: {
            prompt: messages,
            context: nextContext,
          },
          sessionId: String(nextContext?.session?.id || this.activeSessionId || '').trim(),
          details: {
            promptCount: Array.isArray(messages) ? messages.length : 0,
            hasContext: Boolean(nextContext),
          },
          finishDetails: result => ({
            hasPromptOverride: Array.isArray(result?.prompt),
            promptChanged: Array.isArray(result?.prompt) && result.prompt !== beforePrompt,
            promptCount: Array.isArray(result?.prompt) ? result.prompt.length : undefined,
          }),
          logger,
          warningMessage: 'plugin prompt.after_build failed',
          recordTraceEvent: recordPromptHookTraceEvent,
        });
        if (updated && typeof updated === 'object' && Array.isArray(updated.prompt)) {
          messages = updated.prompt;
        }
      }
      if (
        templateSettings.shouldRun('generate', nextContext)
        && (!previewOnly || nextContext?.meta?.previewRawBlocks !== true)
      ) {
        const sessionId = String(nextContext?.session?.id || this.activeSessionId || '').trim();
        try {
          const rendered = await renderTemplateMessages(messages, {
            stage: 'generate',
            chatStore: this.chatStore,
            sessionId,
            variableRuntimeEnabled: this.isVariableRuntimeEnabled?.(sessionId) !== false,
            context: {
              ...(nextContext || {}),
              messages,
            },
            readOnly: previewOnly,
          });
          if (rendered && Array.isArray(rendered.messages)) {
            messages = rendered.messages;
          }
        } catch (err) {
          logger.warn('template render (generate) failed', err);
        }
      }
      messages = this.normalizeOutgoingProviderMessages(messages, config);
      const genOptions = { ...this.getGenerationOptions(presetContext, config), requestContext };
      const withRuntimeParamConstraints = options => ({
        ...options,
        ...(config?.webSearchEnabled === true ? { requestParamConstraints: {
          ...(options.requestParamConstraints || {}),
          protectedParams: [...(options.requestParamConstraints?.protectedParams || []),
            'tools', 'tool_choice', 'toolConfig', 'include', 'max_tool_calls'],
        } } : {}),
      });
      const configuredProviderDirectives = this.buildProviderRequestDirectives(nextContext, presetContext, config);
      const sessionId = String(nextContext?.session?.id || this.activeSessionId || 'default').trim() || 'default';
      const providerToolRequestSchema = buildProviderToolRequestSchema({
        debugUiRegistry: this.debugUiRegistry,
        provider: config?.provider,
        baseUrl: config?.baseUrl,
        apiFormat: config?.apiFormat,
        model: config?.model,
        sessionId,
        existingOptions: [genOptions, configuredProviderDirectives],
      });
      const providerToolBridgeLoopPlan = buildProviderToolBridgeLoopPlan({
        debugUiRegistry: this.debugUiRegistry,
        provider: config?.provider,
        model: config?.model,
        sessionId,
        requestId: nativeRequestId,
        source: 'bridge.generateStream',
        historyMessages: messages,
        providerRequestOptions: { ...providerToolRequestSchema.requestOptions, requestContext },
      });
      const fallbackToolDefinitions = ['web.search', 'web.research', 'web.fetch_url']
        .map(name => this.webSearchToolRuntime?.getTool?.(name))
        .filter(Boolean);
      const webSearchPlan = buildWebSearchRequestPlan({
        enabled: config?.webSearchEnabled === true,
        provider: config?.provider,
        baseUrl: config?.baseUrl,
        model: config?.model,
        existingOptions: [
          genOptions,
          configuredProviderDirectives,
          providerToolRequestSchema.requestOptions,
        ],
        fallbackToolDefinitions,
      });
      const phoneTransportPlan = this.lastPhoneFormatTransportPlan || {};
      const privateChatProviderFcTarget = {
        sessionId,
        targetName: String(nextContext?.session?.name || nextContext?.character?.name || '').trim(),
        speakerId: sessionId,
        speakerName: String(nextContext?.character?.name || nextContext?.session?.name || '').trim(),
        userName: String(nextContext?.user?.name || '我').trim() || '我',
      };
      const groupMemberIds = Array.isArray(nextContext?.group?.members)
        ? nextContext.group.members.map(value => String(value || '').trim())
        : [];
      const groupMemberNames = Array.isArray(nextContext?.group?.memberNames)
        ? nextContext.group.memberNames.map(value => String(value || '').trim())
        : [];
      const frozenGroupMembers = groupMemberIds.map((id, index) => ({
        id,
        name: groupMemberNames[index] || id,
      })).filter(item => item.id && item.name);
      const taskStructuredTargets = nextContext?.task?.structuredTargets && typeof nextContext.task.structuredTargets === 'object'
        ? nextContext.task.structuredTargets
        : {};
      const phoneBatchProviderFcTarget = {
        mode: String(phoneTransportPlan.surface || '').trim(),
        sessionId,
        targetName: String(
          nextContext?.task?.targetName
          || nextContext?.session?.name
          || nextContext?.character?.name
          || '',
        ).trim(),
        speakerId: sessionId,
        speakerName: String(nextContext?.character?.name || nextContext?.session?.name || '').trim(),
        userName: String(nextContext?.user?.name || '我').trim() || '我',
        members: frozenGroupMembers,
        momentId: String(nextContext?.task?.momentId || '').trim(),
        momentAuthors: phoneTransportPlan.surface === 'moment_comment'
          ? (Array.isArray(taskStructuredTargets.momentAuthors) ? taskStructuredTargets.momentAuthors : [])
          : (phoneTransportPlan.surface === 'group_chat'
            ? frozenGroupMembers
            : [{
                id: sessionId,
                name: String(nextContext?.character?.name || nextContext?.session?.name || '').trim(),
              }]),
        privateTargets: Array.isArray(taskStructuredTargets.privateTargets)
          ? taskStructuredTargets.privateTargets
          : [],
        groupTargets: Array.isArray(taskStructuredTargets.groupTargets)
          ? taskStructuredTargets.groupTargets
          : [],
        tableTargets: Array.isArray(phoneTransportPlan.tableTargets)
          ? phoneTransportPlan.tableTargets
          : [],
      };
      const phoneProviderFcContext = {
        uiMode: presetContext?.uiMode,
        surface: phoneTransportPlan.surface,
        isGroupChat: nextContext?.session?.isGroup === true,
        responseTarget: phoneTransportPlan.responseTarget || nextContext?.meta?.responseTarget,
        assistantContinuation: nextContext?.meta?.assistantContinuation?.enabled === true
          || nextContext?.meta?.suppressPendingUserTurn === true,
        webSearchEnabled: config?.webSearchEnabled === true,
        hasProviderTools: hasProviderToolRequestOptions(
          genOptions,
          configuredProviderDirectives,
          providerToolRequestSchema.requestOptions,
          webSearchPlan.requestOptions,
          providerToolBridgeLoopPlan.requestOptions,
        ),
        hasAssistantPrefill: Boolean(configuredProviderDirectives?.deepseekPrefix),
        usesDefaultPreset: phoneTransportPlan.usesDefaultPreset === true,
        usesBuiltinFormat: phoneTransportPlan.usesBuiltinContract === true,
        protocolParserEnabled: phoneTransportPlan.protocolParserEnabled === true,
        hasUnsupportedSideEffects: phoneTransportPlan.requiresBatch === true
          ? phoneTransportPlan.hasUnsupportedBatchSideEffects === true
          : phoneTransportPlan.hasUnsupportedSideEffects === true,
        formatProfileEnabled: nextContext?.meta?.formatProfileEnabled === true,
        compatibilityModeEnabled: appSettings.get().traditionalModelOutputProtocolEnabled === true,
      };
      const privateChatProviderFcAllowedItemTypes = ['text', 'sticker', 'voice', 'transfer', 'music', 'image'];
      const privateChatProviderFcAllowedStickerKeywords = Array.isArray(phoneTransportPlan.stickerKeywords)
        ? phoneTransportPlan.stickerKeywords
        : [];
      const phoneProviderFcUsesBatch = phoneTransportPlan.requiresBatch === true;
      const phoneProviderFcAllowedItemTypes = phoneTransportPlan.surface === 'group_chat'
        ? privateChatProviderFcAllowedItemTypes.filter(type => type !== 'transfer')
        : privateChatProviderFcAllowedItemTypes;
      const phoneProviderFcSnapshotContext = {
        requestId: nativeRequestId,
        turnId: String(nextContext?.meta?.turnId || nativeRequestId).trim(),
        sessionId,
        surface: String(phoneTransportPlan.surface || '').trim(),
        responseTarget: String(
          phoneTransportPlan.responseTarget || nextContext?.meta?.responseTarget || '',
        ).trim(),
        target: phoneProviderFcUsesBatch ? phoneBatchProviderFcTarget : privateChatProviderFcTarget,
        capabilities: {
          provider: phoneProviderFcRelease.capabilities || {},
          reply: phoneTransportPlan.structuredCapabilities || {},
        },
        budget: this.lastMemoryPlan?.budget || {},
        revisions: {
          world: this.lastWorldInjectionDebug?.revision ?? null,
          memory: this.lastMemoryPlan?.revision ?? null,
        },
      };
      const phoneStructuredAdapter = phoneProviderFcUsesBatch ? 'phone_batch' : 'private_reply';
      const phoneStructuredThinkingType = String(genOptions?.thinking?.type || '').trim().toLowerCase();
      const phoneStructuredReasoningEffort = String(
        genOptions?.reasoning?.effort || genOptions?.reasoning_effort || '',
      ).trim().toLowerCase();
      const phoneStructuredThinkingEnabled = Boolean(
        ['enabled', 'adaptive'].includes(phoneStructuredThinkingType)
        || genOptions?.request_reasoning === true
        || (phoneStructuredReasoningEffort
          && !['none', 'off', 'disabled', 'minimal'].includes(phoneStructuredReasoningEffort))
      );
      const phoneStructuredThinkingPlan = resolveChatStructuredThinkingPreference({
        config,
        thinkingEnabled: phoneStructuredThinkingEnabled,
        reasoningOptions: genOptions,
        preference: appSettings.get().chatStructuredThinkingPreference,
      });
      const phoneProviderFcProbation = phoneStructuredThinkingPlan.probation;
      const phoneStructuredEffectiveThinkingEnabled = phoneStructuredThinkingPlan.thinkingEnabled;
      const phoneStructuredTemperature = Number(genOptions?.temperature);
      const preparedPhoneProviderFcRoute = phoneProviderFcUsesBatch
        ? preparePhoneBatchProviderFcRoute({
            enabled: phoneStructuredRoutingRequested
              && (phoneProviderFcRelease.enabled === true || phoneProviderFcProbation.eligible === true),
            config,
            client: requestClient,
            messages,
            transportPlan: phoneTransportPlan,
            context: phoneProviderFcContext,
            target: phoneBatchProviderFcTarget,
            capabilities: phoneTransportPlan.structuredCapabilities || {},
            allowedItemTypes: phoneProviderFcAllowedItemTypes,
            allowedStickerKeywords: privateChatProviderFcAllowedStickerKeywords,
            snapshotContext: phoneProviderFcSnapshotContext,
          })
        : preparePrivateChatProviderFcRoute({
            enabled: phoneStructuredRoutingRequested
              && (phoneProviderFcRelease.enabled === true || phoneProviderFcProbation.eligible === true),
            config,
            client: requestClient,
            messages,
            transportPlan: phoneTransportPlan,
            context: phoneProviderFcContext,
            target: privateChatProviderFcTarget,
            allowedItemTypes: privateChatProviderFcAllowedItemTypes,
            allowedStickerKeywords: privateChatProviderFcAllowedStickerKeywords,
            snapshotContext: phoneProviderFcSnapshotContext,
          });
      const phoneStructuredTextTransport = resolveChatStructuredTextTransport(config);
      const phoneStructuredFcTransport = resolveChatStructuredTextTransport(config, {
        preferProviderFc: true,
      });
      const phoneJsonFormatMetadata = String(config?.provider || '').trim().toLowerCase() === 'openrouter'
        ? readOpenRouterModelCapabilities({ baseUrl: config?.baseUrl, model: config?.model })
        : null;
      const phoneJsonTerminalRoute = preparePhoneReplyJsonRoute({
        enabled: phoneStructuredRoutingRequested && phoneStructuredTextTransport.supported === true,
        config,
        client: requestClient,
        formatCapabilities: derivePhoneReplyJsonFormatCapabilities({
          provider: config?.provider,
          metadataKnown: phoneJsonFormatMetadata?.known === true,
          supportedParameters: phoneJsonFormatMetadata?.supportedParameters || [],
        }),
        messages,
        transportPlan: phoneTransportPlan,
        context: phoneProviderFcContext,
        target: phoneProviderFcUsesBatch ? phoneBatchProviderFcTarget : privateChatProviderFcTarget,
        adapter: phoneStructuredAdapter,
        capabilities: phoneTransportPlan.structuredCapabilities || {},
        allowedItemTypes: phoneProviderFcUsesBatch
          ? phoneProviderFcAllowedItemTypes
          : privateChatProviderFcAllowedItemTypes,
        allowedStickerKeywords: privateChatProviderFcAllowedStickerKeywords,
        snapshotContext: phoneProviderFcSnapshotContext,
      });
      const phoneProviderFcRequestPlan = preparedPhoneProviderFcRoute.eligible === true
        && preparedPhoneProviderFcRoute.toolDefinition
        ? buildProviderFcRequestPlan({
            config,
            tools: [preparedPhoneProviderFcRoute.toolDefinition],
            thinkingEnabled: phoneStructuredEffectiveThinkingEnabled,
            temperature: Number.isFinite(phoneStructuredTemperature)
              ? phoneStructuredTemperature
              : 0.7,
            reasoningOptions: genOptions,
            probationMode: phoneProviderFcRelease.enabled !== true,
          })
        : null;
      const phoneProviderFcEvidenceIdentityResult = buildChatStructuredRequestEvidenceIdentity({
        config,
        mode: CHAT_STRUCTURED_ROUTE_MODES.providerFc,
        adapter: phoneStructuredAdapter,
        surface: phoneTransportPlan.surface,
        capabilities: phoneTransportPlan.structuredCapabilities || {},
        transport: phoneStructuredFcTransport,
      });
      const phoneJsonEvidenceIdentityResult = buildChatStructuredRequestEvidenceIdentity({
        config,
        mode: CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal,
        adapter: phoneStructuredAdapter,
        surface: phoneTransportPlan.surface,
        capabilities: phoneTransportPlan.structuredCapabilities || {},
        transport: phoneStructuredTextTransport,
      });
      const phoneProviderFcEvidence = phoneProviderFcEvidenceIdentityResult.ok
        ? chatStructuredRouteEvidenceStore.get(
            phoneProviderFcEvidenceIdentityResult.identity,
            CHAT_STRUCTURED_ROUTE_MODES.providerFc,
          )
        : null;
      const phoneProviderFcEvidenceKey = phoneProviderFcEvidenceIdentityResult.ok
        ? getChatStructuredEvidenceKey(
            phoneProviderFcEvidenceIdentityResult.identity,
            CHAT_STRUCTURED_ROUTE_MODES.providerFc,
          )
        : '';
      const phoneJsonEvidenceKey = phoneJsonEvidenceIdentityResult.ok
        ? getChatStructuredEvidenceKey(
            phoneJsonEvidenceIdentityResult.identity,
            CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal,
          )
        : '';
      const phoneJsonEvidence = phoneJsonEvidenceIdentityResult.ok
        ? chatStructuredRouteEvidenceStore.get(
            phoneJsonEvidenceIdentityResult.identity,
            CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal,
          )
        : null;
      const phoneStructuredHardBoundary = resolveChatStructuredHardBoundary({
        enabled: phoneStructuredRoutingRequested,
        context: phoneProviderFcContext,
      });
      const phoneProviderFcHalfOpenAvailability = phoneProviderFcEvidenceIdentityResult.ok
        ? chatStructuredRouteEvidenceStore.getHalfOpenAvailability(
            phoneProviderFcEvidenceIdentityResult.identity,
            CHAT_STRUCTURED_ROUTE_MODES.providerFc,
          )
        : null;
      const phoneJsonHalfOpenAvailability = phoneJsonEvidenceIdentityResult.ok
        ? chatStructuredRouteEvidenceStore.getHalfOpenAvailability(
            phoneJsonEvidenceIdentityResult.identity,
            CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal,
          )
        : null;
      const buildPhoneStructuredRouteDecision = ({ fcLeaseAvailable = true, jsonLeaseAvailable = true } = {}) => resolveChatStructuredRoute({
        enabled: phoneStructuredRoutingRequested,
        hardBoundaryReason: phoneStructuredHardBoundary,
        verifiedFc: {
          ...phoneProviderFcRelease,
          enabled: phoneProviderFcRelease.enabled === true
            && phoneProviderFcProbation.reason !== 'thinking_preservation_requires_json'
            && preparedPhoneProviderFcRoute.eligible === true
            && phoneProviderFcRequestPlan?.ok === true,
        },
        fcProbation: {
          ...phoneProviderFcProbation,
          eligible: phoneProviderFcProbation.eligible === true
            && preparedPhoneProviderFcRoute.eligible === true
            && phoneProviderFcRequestPlan?.ok === true,
          reason: phoneProviderFcRequestPlan?.ok === false
            ? phoneProviderFcRequestPlan.reason
            : phoneProviderFcProbation.reason,
        },
        jsonTerminal: {
          eligible: phoneJsonTerminalRoute.eligible === true,
          reason: phoneJsonTerminalRoute.reason,
        },
        fcEvidence: phoneProviderFcEvidence,
        jsonEvidence: phoneJsonEvidence,
        fcHalfOpenLeaseAvailable: fcLeaseAvailable,
        jsonHalfOpenLeaseAvailable: jsonLeaseAvailable,
      });
      let phoneStructuredRouteDecision = buildPhoneStructuredRouteDecision({
        fcLeaseAvailable: phoneProviderFcHalfOpenAvailability?.reason !== 'half_open_busy',
        jsonLeaseAvailable: phoneJsonHalfOpenAvailability?.reason !== 'half_open_busy',
      });
      let phoneStructuredHalfOpenLeaseHeld = false;
      if (phoneStructuredRouteDecision.halfOpen === true) {
        const halfOpenIdentityResult = phoneStructuredRouteDecision.mode === CHAT_STRUCTURED_ROUTE_MODES.providerFc
          ? phoneProviderFcEvidenceIdentityResult
          : phoneJsonEvidenceIdentityResult;
        phoneStructuredHalfOpenLeaseHeld = halfOpenIdentityResult.ok
          && chatStructuredRouteEvidenceStore.tryAcquireHalfOpen(
            halfOpenIdentityResult.identity,
            phoneStructuredRouteDecision.mode,
            { requestId: nativeRequestId },
          );
        if (!phoneStructuredHalfOpenLeaseHeld) {
          phoneStructuredRouteDecision = buildPhoneStructuredRouteDecision({
            fcLeaseAvailable: phoneStructuredRouteDecision.mode !== CHAT_STRUCTURED_ROUTE_MODES.providerFc,
            jsonLeaseAvailable: phoneStructuredRouteDecision.mode !== CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal,
          });
        }
      }
      const phoneStructuredRouteMode = phoneStructuredRouteDecision.mode;
      const phoneStructuredContractSummary = buildChatStructuredContractSummary({
        adapter: phoneStructuredAdapter,
        surface: phoneTransportPlan.surface,
        target: phoneProviderFcUsesBatch ? phoneBatchProviderFcTarget : privateChatProviderFcTarget,
        capabilities: phoneTransportPlan.structuredCapabilities || {},
        allowedItemTypes: phoneProviderFcUsesBatch
          ? phoneProviderFcAllowedItemTypes
          : privateChatProviderFcAllowedItemTypes,
        allowedStickerKeywords: privateChatProviderFcAllowedStickerKeywords,
      });
      const phoneProviderFcRoute = phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.providerFc
        ? {
            ...preparedPhoneProviderFcRoute,
            routeMode: CHAT_STRUCTURED_ROUTE_MODES.providerFc,
          }
        : (phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal
            ? {
                ...phoneJsonTerminalRoute,
                routeMode: CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal,
                toolSchemaDiagnostics: null,
              }
            : {
                eligible: false,
                reason: phoneStructuredRouteDecision.reason,
                routeMode: CHAT_STRUCTURED_ROUTE_MODES.legacyText,
                messages: [],
                semanticSnapshot: phoneJsonTerminalRoute.semanticSnapshot
                  || preparedPhoneProviderFcRoute.semanticSnapshot
                  || null,
                snapshotFingerprint: phoneJsonTerminalRoute.snapshotFingerprint
                  || preparedPhoneProviderFcRoute.snapshotFingerprint
                  || '',
                promptDiagnostics: phoneJsonTerminalRoute.promptDiagnostics
                  || preparedPhoneProviderFcRoute.promptDiagnostics
                  || null,
              });
      let primaryLegacyAssembly = null;
      if (phoneTransportPlan.transportLayersDeferred === true && !phoneProviderFcRoute.eligible) {
        primaryLegacyAssembly = phoneProviderFcRoute.semanticSnapshot
          ? assembleLegacyTextRequest(phoneProviderFcRoute.semanticSnapshot)
          : restoreDeferredLegacyTextMessages({
              messages,
              deferredLegacyLayers: phoneTransportPlan.deferredLegacyLayers,
            });
        if (!primaryLegacyAssembly.ok) {
          throw new Error(`Deferred text transport unavailable: ${primaryLegacyAssembly.reason}`);
        }
        messages = primaryLegacyAssembly.messages;
      }
      const phoneProviderFcStreamPreviewEnabled = Boolean(
        phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.providerFc
        && phoneProviderFcRoute.eligible
        && phoneProviderFcRelease.capabilities?.streamingArguments === true
        && config?.stream === true
        && phoneStructuredPreviewCallback,
      );
      if (config?.webSearchEnabled === true && webSearchPlan.enabled !== true) {
        const warningSignature = `${webSearchPlan.route}:${webSearchPlan.diagnostics?.reason || ''}`;
        if (this.lastWebSearchWarningSignature !== warningSignature) {
          this.lastWebSearchWarningSignature = warningSignature;
          try {
            window.dispatchEvent(new CustomEvent('chatapp-web-search-unavailable', {
              detail: {
                reason: String(webSearchPlan.diagnostics?.reason || '当前模型无法启用联网'),
                provider: String(config?.provider || ''),
                model: String(config?.model || ''),
              },
            }));
          } catch {}
        }
      }
      const prefillExperimentStatus = (() => {
        try {
          const action = this.debugUiRegistry?.actions?.getDeepSeekPhonePrefillExperimentStatus;
          return typeof action === 'function' ? action() : null;
        } catch {
          return null;
        }
      })();
      const phonePrefillPlan = resolveDeepSeekPhonePrefillPlan({
        experimentEnabled: prefillExperimentStatus?.enabled === true,
        provider: config?.provider,
        model: config?.model,
        baseUrl: config?.baseUrl,
        uiMode: presetContext?.uiMode,
        surface: this.lastDeepSeekFormatDebug?.contractSurface || '',
        responseTarget: this.lastDeepSeekFormatDebug?.responseTarget || nextContext?.meta?.responseTarget,
        assistantContinuation: nextContext?.meta?.assistantContinuation?.enabled === true
          || nextContext?.meta?.suppressPendingUserTurn === true,
        hasConfiguredPrefill: Boolean(configuredProviderDirectives?.deepseekPrefix),
        usesDefaultPreset: this.lastDeepSeekFormatDebug?.isDefaultOpenAIPreset === true,
        usesBuiltinContract: this.lastDeepSeekFormatDebug?.dsFormatInjected === true,
        formatProfileEnabled: nextContext?.meta?.formatProfileEnabled === true,
        webSearchEnabled: config?.webSearchEnabled === true,
        hasProviderTools: hasProviderToolRequestOptions(
          genOptions,
          configuredProviderDirectives,
          providerToolRequestSchema.requestOptions,
          webSearchPlan.requestOptions,
          providerToolBridgeLoopPlan.requestOptions,
        ),
      });
      const providerDirectives = {
        ...(configuredProviderDirectives || {}),
        ...(phonePrefillPlan.requestOptions || {}),
      };
      const requestOptions = withRuntimeParamConstraints({
        ...(genOptions || {}),
        ...(providerDirectives || {}),
        ...(providerToolRequestSchema.requestOptions || {}),
        ...(webSearchPlan.requestOptions || {}),
        signal: abortController.signal,
        nativeRequestId,
        ...(providerToolBridgeLoopPlan.requestOptions || {}),
      });
      const phoneProviderFcRequestOptions = withRuntimeParamConstraints({
        ...(genOptions || {}),
        requestParamConstraints: { protectedParams: ['tools', 'tool_choice', 'parallel_tool_calls', 'response_format', 'text.format'] },
        signal: abortController.signal,
        nativeRequestId,
      });
      const phoneProviderFcPlanDebugOptions = buildProviderFcRequestOptionsForLocalDiagnostics(
        phoneProviderFcRequestPlan,
      );
      const phoneProviderFcDebugRequestOptions = withRuntimeParamConstraints({
        ...sanitizeProviderFcInheritedRequestOptions({
          provider: config?.provider,
          options: genOptions,
        }),
        ...phoneProviderFcPlanDebugOptions,
      });
      const phoneJsonTerminalRequestOptions = withRuntimeParamConstraints({
        ...(genOptions || {}),
        requestParamConstraints: { tools: 'none', protectedParams: ['response_format', 'text.format'] },
        ...(phoneJsonTerminalRoute.requestOptions || {}),
        signal: abortController.signal,
        nativeRequestId,
      });
      const phoneJsonTerminalDebugRequestOptions = withRuntimeParamConstraints({
        ...(genOptions || {}),
        ...(phoneJsonTerminalRoute.requestOptions || {}),
      });
      // Phase B 主任务计量：本次生成的真实 provider usage（chat/stream 均经 onProviderUsage 上报）。
      // 回调保留在运行时选项中，协议组装时剥离；主流程 finalize 消息时 consume 一次挂到 meta.usage。
      // consume-once：协议路径一次生成可 emit 多条消息，usage 属于整次生成，只挂到首条，避免重复计量。
      this.lastGenerationUsage = null;
      this.lastGenerationSources = null;
      const generationStartedAt = Date.now();
      let rawEstimatedPromptTokens = 0;
      let calibrationRecorded = false;
      let calibrationEligible = true;
      const providerCallTracker = createGenerationProviderCallDiagnosticsTracker();
      let activeProviderCallId = '';
      let generationUsage = null;

      const getProviderCalls = () => providerCallTracker.snapshot();
      const syncGenerationUsageSnapshot = () => {
        const providerCalls = getProviderCalls();
        const responseDiagnostics = this.lastRequest?.requestId === nativeRequestId
          ? (this.lastRequest.responseDiagnostics || {})
          : {};
        const merged = mergeResponseDiagnosticsIntoUsage(
          generationUsage,
          responseDiagnostics,
          { providerCalls },
        );
        if (!merged) {
          this.lastGenerationUsage = null;
          return;
        }
        const calibration = this.getTokenCalibration(config?.provider, config?.model);
        this.lastGenerationUsage = {
          provider: String(generationUsage?.provider || config?.provider || ''),
          model: String(generationUsage?.model || config?.model || ''),
          ...merged,
          modelCallCount: providerCalls.length,
          estimatedPromptTokens: rawEstimatedPromptTokens,
          tokenCalibrationCoefficient: calibration.coefficient,
          tokenCalibrationSamples: calibration.samples,
        };
      };
      const syncProviderCallsToRequest = () => {
        if (this.lastRequest?.requestId !== nativeRequestId) return;
        this.lastRequest.responseDiagnostics = {
          ...(this.lastRequest.responseDiagnostics || {}),
          providerCalls: getProviderCalls(),
          usagePersistenceTarget: 'generation_record',
        };
        syncGenerationUsageSnapshot();
      };
      const startProviderCall = (mode, stream) => {
        generationUsage = null;
        activeProviderCallId = providerCallTracker.start({
          mode,
          provider: config?.provider,
          model: config?.model,
          stream: stream === true,
        });
        syncProviderCallsToRequest();
        return activeProviderCallId;
      };
      const markFirstProviderDelta = ({ at = Date.now() } = {}) => {
        if (!activeProviderCallId) return;
        if (!providerCallTracker.markFirstMeaningfulDelta(activeProviderCallId, { at })) return;
        if (this.lastRequest?.requestId === nativeRequestId) {
          this.lastRequest.responseDiagnostics = buildFirstTokenResponseDiagnostics(
            this.lastRequest.responseDiagnostics,
            {
              requestStartedAt: generationStartedAt,
              firstTokenAt: at,
              stream: true,
            },
          );
        }
        syncProviderCallsToRequest();
      };
      const finishProviderCall = (outcome, completedAt = Date.now()) => {
        if (!activeProviderCallId) return;
        providerCallTracker.finish(activeProviderCallId, {
          outcome,
          completedAt,
          usage: generationUsage,
        });
        activeProviderCallId = '';
        syncProviderCallsToRequest();
      };
      const resetResponseForNextProviderCall = () => {
        if (this.lastRequest?.requestId !== nativeRequestId) return;
        const next = { ...(this.lastRequest.responseDiagnostics || {}) };
        [
          'completedAt',
          'latencyMs',
          'outputDurationMs',
          'tokensPerSecond',
          'promptTokens',
          'completionTokens',
          'totalTokens',
          'finishReason',
          'systemFingerprint',
          'modelVersion',
          'responseId',
          'responseModel',
          'routedProvider',
          'webSearchRequests',
          'webSearchTokens',
          'webSearchEngine',
        ].forEach(key => { delete next[key]; });
        this.lastRequest.responseDiagnostics = {
          ...next,
          providerCalls: getProviderCalls(),
          usagePersistenceTarget: 'generation_record',
        };
      };
      const completeGenerationDiagnostics = ({ completedAt = Date.now(), stream = false } = {}) => {
        if (this.lastRequest?.requestId !== nativeRequestId) return;
        const providerCalls = getProviderCalls();
        const next = buildCompletedResponseDiagnostics(
          this.lastRequest.responseDiagnostics,
          {
            requestStartedAt: generationStartedAt,
            completedAt,
            usage: generationUsage,
            stream,
          },
        );
        if (providerCalls.length > 1) {
          next.outputDurationMs = null;
          next.tokensPerSecond = null;
        }
        this.lastRequest.responseDiagnostics = {
          ...next,
          providerCalls,
          usagePersistenceTarget: 'generation_record',
        };
        syncGenerationUsageSnapshot();
      };
      requestOptions.onProviderUsage = (usage) => {
        const completedAt = Date.now();
        generationUsage = usage && typeof usage === 'object' ? { ...usage } : null;
        if (activeProviderCallId) {
          providerCallTracker.observeUsage(activeProviderCallId, generationUsage);
        }
        let calibration = this.getTokenCalibration(config?.provider, config?.model);
        const actualPromptTokens = Math.trunc(Number(usage?.promptTokens));
        if (
          !calibrationRecorded
          && calibrationEligible
          && Number.isFinite(actualPromptTokens)
          && actualPromptTokens > 0
          && rawEstimatedPromptTokens > 0
        ) {
          calibration = tokenCalibrationStore.update({
            provider: usage?.provider || config?.provider,
            model: usage?.model || config?.model,
            estimatedTokens: rawEstimatedPromptTokens,
            actualPromptTokens,
          });
          calibrationRecorded = true;
        }
        // 只允许回写到本请求自己的 audit：lastRequest 可能已被并发的后台请求
        // （agent/压缩/图片）换成别的请求，盖过去会把别档模型的系数展示到错误面板上。
        if (this.lastRequest?.injectionAudit && this.lastRequest.requestId === nativeRequestId) {
          this.lastRequest.injectionAudit.calibration = { ...calibration };
        }
        if (this.lastRequest?.requestId === nativeRequestId) {
          const measured = buildCompletedResponseDiagnostics(
            this.lastRequest.responseDiagnostics,
            {
              requestStartedAt: generationStartedAt,
              completedAt,
              usage: generationUsage,
              stream: Boolean(config?.stream),
            },
          );
          this.lastRequest.responseDiagnostics = {
            ...(this.lastRequest.responseDiagnostics || {}),
            stream: measured.stream,
            promptTokens: measured.promptTokens,
            completionTokens: measured.completionTokens,
            totalTokens: measured.totalTokens,
            finishReason: measured.finishReason,
            systemFingerprint: measured.systemFingerprint,
            modelVersion: measured.modelVersion,
            responseId: measured.responseId,
            responseModel: measured.responseModel,
            routedProvider: measured.routedProvider,
            webSearchRequests: measured.webSearchRequests,
            webSearchTokens: measured.webSearchTokens,
            webSearchEngine: measured.webSearchEngine,
            providerCalls: getProviderCalls(),
            usagePersistenceTarget: 'generation_record',
          };
        }
        syncGenerationUsageSnapshot();
      };
      requestOptions.onProviderSources = (sources) => {
        this.lastGenerationSources = mergeWebSources(this.lastGenerationSources || [], sources || []);
      };
      const reportWebSearchStatus = (status = {}) => {
        const detail = {
          state: String(status?.state || '').trim(),
          message: String(status?.message || '').trim(),
          execution: String(
            status?.execution
            || (webSearchPlan.native ? 'provider_native' : 'app_tool'),
          ).trim(),
          provider: String(status?.provider || config?.provider || '').trim(),
          engine: String(status?.engine || '').trim(),
          route: String(webSearchPlan.route || '').trim(),
          searchRequests: status?.searchRequests !== null
            && status?.searchRequests !== undefined
            && Number.isFinite(Number(status.searchRequests))
            ? Math.max(0, Math.trunc(Number(status.searchRequests)))
            : null,
          sourceCount: status?.sourceCount !== null
            && status?.sourceCount !== undefined
            && Number.isFinite(Number(status.sourceCount))
            ? Math.max(0, Math.trunc(Number(status.sourceCount)))
            : null,
          sessionId,
          requestId: nativeRequestId,
        };
        if (this.lastRequest?.requestId === nativeRequestId) {
          this.lastRequest.webSearchStatus = { ...detail };
        }
        try {
          window.dispatchEvent(new CustomEvent('chatapp-web-search-status', { detail }));
        } catch {}
      };
      if (webSearchPlan.fallback === true || webSearchPlan.route === 'kimi_native') {
        requestOptions.onWebSearchStatus = reportWebSearchStatus;
      }
      if (webSearchPlan.native === true) {
        requestOptions.onProviderSearchActivity = (activity = {}) => {
          reportWebSearchStatus({
            ...activity,
            message: activity?.state === 'done'
              ? '供应方原生联网搜索完成'
              : '供应方正在原生联网搜索…',
          });
        };
      }
      const generationClient = createWebSearchGenerationClient({
        client: requestClient,
        plan: webSearchPlan,
        toolRuntime: this.webSearchToolRuntime,
        provider: config?.provider,
        model: config?.model,
        sessionId,
      });
      const preparedRequest = phoneProviderFcRoute.eligible
        ? null
        : (generationClient?.prepareChatRequest?.(messages, { ...requestOptions, stream: Boolean(config?.stream) }) || null);
      const legacyResponsePrefix = String(preparedRequest?.responsePrefix || '');
      const finalRequestMessages = preparedRequest?.messages || messages;
      const requestPayloadMessages = phoneProviderFcRoute.eligible
        ? phoneProviderFcRoute.messages
        : finalRequestMessages;
      const requestPayloadOptions = phoneProviderFcRoute.eligible
        ? (phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal
            ? phoneJsonTerminalRequestOptions
            : phoneProviderFcRequestOptions)
        : requestOptions;
      let responsePrefix = phoneProviderFcRoute.eligible ? '' : legacyResponsePrefix;
      rawEstimatedPromptTokens = estimatePromptMessagesTokens(requestPayloadMessages, 'rough');
      const structuredContractMessages = phoneProviderFcRoute.eligible
        ? requestPayloadMessages.filter((message) => {
            const content = typeof message?.content === 'string' ? message.content.trimStart() : '';
            return content.startsWith('本轮使用结构化')
              || content.startsWith('本轮使用 JSON 结构化终态')
              || content.startsWith('This turn uses structured')
              || content.startsWith('This turn uses the JSON structured terminal');
          })
        : [];
      const structuredContractMessageEstimateTokens = estimatePromptMessagesTokens(
        structuredContractMessages,
        'rough',
      );
      const structuredSchemaForEstimate = phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal
        ? (phoneJsonTerminalRoute.schema || {})
        : (phoneProviderFcRoute.toolSchemaLocal?.schema
            || phoneProviderFcRoute.toolSchemaDiagnostics?.schema
            || {});
      const schemaEstimateTokens = estimateTokens(
        JSON.stringify(structuredSchemaForEstimate),
        'rough',
      );
      const embeddedJsonSchemaEstimateTokens = (
        phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal
        && phoneJsonTerminalRoute.formatMode !== 'json_schema'
      ) ? schemaEstimateTokens : 0;
      const contractInstructionEstimateTokens = Math.max(
        0,
        structuredContractMessageEstimateTokens - embeddedJsonSchemaEstimateTokens,
      );
      const semanticMessageEstimateTokens = Math.max(
        0,
        rawEstimatedPromptTokens - structuredContractMessageEstimateTokens,
      );
      // 带图/语音请求不进校准样本：估算把附件折成占位符，而 usage 含真实附件 token，
      // 比值会被顶到上限并经 EWMA 拉高系数，之后纯文本请求会被系统性高估。
      calibrationEligible = config?.webSearchEnabled !== true
        && !promptMessagesContainNonTextContent(requestPayloadMessages);
      const globalPromptAudit = this.lastGlobalSemanticPromptAudit
        && typeof this.lastGlobalSemanticPromptAudit === 'object'
        ? this.lastGlobalSemanticPromptAudit
        : null;
      const globalPromptAuditSegments = globalPromptAudit?.usedTokens > 0
        ? [{
            id: globalPromptAudit.segmentId || 'global_prompt_library',
            label: globalPromptAudit.label || '全局提示词',
            usedTokens: globalPromptAudit.usedTokens,
            messageCount: globalPromptAudit.messageCount,
            detail: `${globalPromptAudit.messageCount || 0} 个启用块`,
          }]
        : [];
      const injectionAudit = buildRequestInjectionAudit({
        memoryPlan: this.lastMemoryPlan,
        extraSegments: globalPromptAuditSegments,
        history: nextContext?.history,
        worldDebug: this.lastWorldInjectionDebug,
        messages: requestPayloadMessages,
        budget: this.lastMemoryPlan?.budget,
        mode: this.lastMemoryPlan?.budget?.mode,
        tokenMode: requestTokenMode,
      });
      injectionAudit.calibration = { ...requestCalibration };
      injectionAudit.coverageLine = this.lastMemoryPlan?.coverageLine || null;
      injectionAudit.historyBudgetStats = this.lastMemoryPlan?.historyBudgetStats || null;
      injectionAudit.globalPrompt = globalPromptAudit;
      if (this.lastMemoryPlan && typeof this.lastMemoryPlan === 'object') {
        this.lastMemoryPlan = {
          ...this.lastMemoryPlan,
          requestAudit: injectionAudit,
        };
      }

      logger.debug('发送消息到 LLM:', { messageCount: messages.length, stream: Boolean(config?.stream) });
      // Debug: keep the exact request payload used for the latest generation
      this.lastRequest = {
        at: Date.now(),
        requestId: nativeRequestId,
        scopeId: String(this.scopeId || '').trim(),
        provider: config?.provider,
        baseUrl: sanitizeRequestPreviewUrl(config?.baseUrl),
        ...(['custom', 'opencode'].includes(config?.provider) ? { apiFormat: config?.apiFormat || 'chat_completions' } : {}),
        ...(preparedRequest?.body ? { wireRequest: {
          url: sanitizeRequestPreviewUrl(preparedRequest.url),
          body: preparedRequest.body,
          parameterReport: preparedRequest.parameterReport || [],
        }, ...(preparedRequest.body.input ? { apiFormat: 'responses' } : {}) } : {}),
        model: config?.model,
        stream: phoneProviderFcRoute.eligible
          ? (phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal
              ? Boolean(config?.stream)
              : phoneProviderFcStreamPreviewEnabled)
          : Boolean(config?.stream),
        configProfile: {
          id: requestRuntime?.profileId || '',
          source: requestRuntime?.bindingSource || 'global',
          bound: requestRuntime?.bound === true,
        },
        session: {
          id: sessionId,
          name: String(nextContext?.session?.name || '').trim(),
          isGroup: Boolean(nextContext?.session?.isGroup),
        },
        presetContext,
        task: nextContext?.task && typeof nextContext.task === 'object'
          ? {
              type: String(nextContext.task.type || '').trim(),
              mode: String(nextContext.task.mode || '').trim(),
              targetName: String(nextContext.task.targetName || '').trim(),
              targetSessionId: String(nextContext.task.targetSessionId || '').trim(),
              isReplyToComment: Boolean(nextContext.task.isReplyToComment),
            }
          : null,
        options: phoneProviderFcRoute.eligible
          ? (phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal
              ? phoneJsonTerminalDebugRequestOptions
              : phoneProviderFcDebugRequestOptions)
          : (preparedRequest?.normalizedOptions || genOptions),
        requestOptions: {
          ...(phoneProviderFcRoute.eligible
            ? (phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal
                ? phoneJsonTerminalDebugRequestOptions
                : phoneProviderFcDebugRequestOptions)
            : withRuntimeParamConstraints({
                ...(genOptions || {}),
                ...(providerDirectives || {}),
                ...(providerToolRequestSchema.requestOptions || {}),
                ...(webSearchPlan.requestOptions || {}),
              })),
        },
        providerToolRequestSchema: providerToolRequestSchema.diagnostics,
        providerToolBridgeLoop: providerToolBridgeLoopPlan.diagnostics,
        webSearch: webSearchPlan.diagnostics,
        webSearchStatus: webSearchPlan.enabled === true
          ? {
              state: 'ready_not_observed',
              message: '已开放联网工具，本轮尚未观察到搜索',
              execution: webSearchPlan.native ? 'provider_native' : 'app_tool',
              provider: String(config?.provider || '').trim(),
              engine: String(webSearchPlan.diagnostics?.searchEngine || '').trim(),
              route: String(webSearchPlan.route || '').trim(),
              searchRequests: null,
              sourceCount: 0,
              sessionId,
              requestId: nativeRequestId,
            }
          : null,
        deepSeekPhonePrefill: phoneProviderFcRoute.eligible
          ? {
              ...(phonePrefillPlan.diagnostics || {}),
              eligible: false,
              reason: `${phoneStructuredRouteMode}_active`,
            }
          : phonePrefillPlan.diagnostics,
        phoneReplyTransport: {
          previewState: previewOnly ? 'predicted' : 'actual',
          requestedMode: phoneStructuredRoutingRequested ? phoneStructuredRouteMode : 'legacy_text',
          effectiveMode: phoneProviderFcRoute.eligible ? phoneStructuredRouteMode : 'legacy_text',
          routeLayer: String(phoneStructuredRouteDecision.layer || ''),
          routeReason: String(phoneStructuredRouteDecision.reason || ''),
          fallbackFrom: String(phoneStructuredRouteDecision.fallbackFrom || ''),
          thinkingRequested: phoneStructuredThinkingPlan.thinkingRequested === true,
          thinkingEnabled: phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.providerFc
            ? phoneStructuredThinkingPlan.thinkingEnabled === true
            : phoneStructuredThinkingPlan.thinkingRequested === true,
          thinkingOverrideReason: phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.providerFc
            ? String(phoneStructuredThinkingPlan.thinkingOverrideReason || '')
            : '',
          adapter: phoneStructuredAdapter,
          eligible: phoneProviderFcRoute.eligible === true,
          eligibilityReason: String(phoneProviderFcRoute.reason || ''),
          providerRolloutEnabled: phoneProviderFcRelease.enabled === true,
          providerRolloutReason: String(phoneProviderFcRelease.reason || ''),
          providerModel: String(phoneProviderFcRelease.model || config?.model || ''),
          capabilitySource: String(phoneProviderFcRelease.capabilitySource || ''),
          capabilityLayer: String(phoneProviderFcRelease.capabilityLayer || ''),
          capabilityRuleId: String(phoneProviderFcRelease.capabilityRuleId || ''),
          probationEligible: phoneProviderFcProbation.eligible === true,
          probationReason: String(phoneProviderFcProbation.reason || ''),
          evidenceKey: String(
            phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal
              ? phoneJsonEvidenceKey
              : phoneProviderFcEvidenceKey,
          ),
          evidenceStatus: String(
            phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal
              ? (phoneJsonEvidence?.health?.status || 'unobserved')
              : (phoneProviderFcEvidence?.health?.status || 'unobserved'),
          ),
          evidenceStrictSuccessCount: Number(
            phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal
              ? (phoneJsonEvidence?.health?.strictSuccessCount || 0)
              : (phoneProviderFcEvidence?.health?.strictSuccessCount || 0),
          ),
          circuitOpen: (
            phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal
              ? phoneJsonEvidence?.health?.circuitOpen
              : phoneProviderFcEvidence?.health?.circuitOpen
          ) === true,
          cooldownUntil: Number(
            phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal
              ? (phoneJsonEvidence?.health?.cooldownUntil || 0)
              : (phoneProviderFcEvidence?.health?.cooldownUntil || 0),
          ),
          localRuleCircuitOpen: phoneProviderFcRelease.localRuleHealth?.circuitOpen === true,
          localRuleFailureCount: Number(
            phoneProviderFcRelease.localRuleHealth?.consecutiveDeterministicFailures || 0,
          ),
          localRuleLastFailureReason: String(
            phoneProviderFcRelease.localRuleHealth?.lastFailureReason || '',
          ),
          localRuleHealthAction: '',
          snapshotFingerprint: String(phoneProviderFcRoute.snapshotFingerprint || ''),
          primaryAssembly: primaryLegacyAssembly
            ? (primaryLegacyAssembly.snapshotFingerprint
                ? 'lazy_legacy_from_snapshot'
                : 'deferred_anchor_restore')
            : '',
          attempted: false,
          fallbackReason: '',
          toolCallCount: 0,
          validationErrorCount: 0,
          validationErrorCodes: [],
          argumentRepairApplied: false,
          argumentRepairKinds: [],
          streamPreviewUsed: false,
          previewUpdateCount: 0,
          previewChars: 0,
          previewFieldCount: 0,
          previewTruncated: false,
          firstPreviewLatencyMs: 0,
          terminalToolSchema: phoneProviderFcRoute.toolSchemaLocal
            || phoneProviderFcRoute.toolSchemaDiagnostics
            || null,
          contractSummary: phoneProviderFcRoute.eligible
            ? phoneStructuredContractSummary
            : null,
          jsonContract: phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal
            ? {
                version: 'phone.reply.ir.v1',
                formatMode: String(phoneJsonTerminalRoute.formatMode || 'prompt_json'),
                schema: phoneJsonTerminalRoute.schema || null,
              }
            : null,
          schemaEstimateTokens,
          semanticMessageEstimateTokens,
          contractInstructionEstimateTokens,
          promptDiagnostics: phoneProviderFcRoute.promptDiagnostics || null,
        },
        messages: requestPayloadMessages,
        responsePrefix,
        worldDebug: this.lastWorldInjectionDebug || null,
        deepSeekFormatDebug: this.lastDeepSeekFormatDebug || null,
        injectionAudit,
      };
      this.lastRequest.lineageTrace = buildPromptTraceFromRequest(this.lastRequest, {
        requestId: nativeRequestId,
        scopeId: this.scopeId || sessionId,
      });
      this.lastRequest.promptCacheDebug = previewOnly
        ? buildPromptCacheDebugSnapshot(requestPayloadMessages)
        : this.emitPromptCacheDebug(
            sessionId,
            requestPayloadMessages,
            {
              provider: config?.provider,
              model: config?.model,
              stream: Boolean(config?.stream),
              requestId: nativeRequestId,
            },
          );

      if (previewOnly) {
        if (!preparedRequest && phoneProviderFcRoute.eligible) {
          const predicted = requestClient?.prepareChatRequest?.(requestPayloadMessages, {
            ...(phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal
              ? phoneJsonTerminalDebugRequestOptions : {
                  ...phoneProviderFcDebugRequestOptions,
                  ...phoneProviderFcRequestPlan.generationOptions,
                  ...phoneProviderFcRequestPlan.requestOptions,
                }),
            maxTokens: Number(requestPayloadOptions?.max_tokens ?? requestPayloadOptions?.maxTokens) > 0
              ? Number(requestPayloadOptions.max_tokens ?? requestPayloadOptions.maxTokens) : (phoneProviderFcUsesBatch ? 3200 : 2400),
            requestParamConstraints: requestPayloadOptions.requestParamConstraints,
            stream: this.lastRequest.stream,
          });
          if (predicted?.body) this.lastRequest.wireRequest = {
            url: sanitizeRequestPreviewUrl(predicted.url), body: predicted.body,
            parameterReport: predicted.parameterReport || [],
          };
        }
        this.lastRequest.previewOnly = true;
        this.lastRequest.source = 'prompt_preview';
        return this.lastRequest;
      }

      const recordPreparedRequest = ({ body, parameterReport, protocol } = {}) => {
        if (!body || this.lastRequest?.requestId !== nativeRequestId) return;
        this.lastRequest.wireRequest = { ...(this.lastRequest.wireRequest || {}), body, parameterReport: parameterReport || [] };
        if (protocol === 'responses') this.lastRequest.apiFormat = 'responses';
      };
      requestOptions.onProviderRequestPrepared = recordPreparedRequest;
      phoneProviderFcRequestOptions.onProviderRequestPrepared = recordPreparedRequest;
      phoneJsonTerminalRequestOptions.onProviderRequestPrepared = recordPreparedRequest;

      const emitPhoneStructuredRouteStatus = (state, detail = {}) => {
        if (!phoneProviderFcRoute.eligible) return;
        try {
          window.dispatchEvent(new CustomEvent('chatapp-phone-structured-route-status', {
            detail: {
              state,
              mode: phoneStructuredRouteMode,
              layer: String(phoneStructuredRouteDecision.layer || ''),
              sessionId,
              requestId: nativeRequestId,
              ...detail,
            },
          }));
        } catch {}
      };
      if (phoneProviderFcRoute.eligible) {
        const configuredMaxTokens = Number(
          requestPayloadOptions?.max_tokens ?? requestPayloadOptions?.maxTokens,
        );
        const configuredTemperature = Number(requestPayloadOptions?.temperature);
        const structuredMaxTokens = Number.isFinite(configuredMaxTokens) && configuredMaxTokens > 0
          ? Math.trunc(configuredMaxTokens)
          : (phoneProviderFcUsesBatch ? 3200 : 2400);
        emitPhoneStructuredRouteStatus('generating', {
          message: '正在生成结构化回复…',
        });
        const structuredCallStream = phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal
          ? Boolean(config?.stream)
          : phoneProviderFcStreamPreviewEnabled;
        startProviderCall(phoneStructuredRouteMode, structuredCallStream);
        let phoneStructuredAttempt;
        if (phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal) {
          phoneStructuredAttempt = await runPhoneReplyJsonAttempt({
            enabled: true,
            client: requestClient,
            config,
            messages: phoneProviderFcRoute.messages,
            adapter: phoneStructuredAdapter,
            target: phoneProviderFcUsesBatch ? phoneBatchProviderFcTarget : privateChatProviderFcTarget,
            capabilities: phoneTransportPlan.structuredCapabilities || {},
            allowedItemTypes: phoneProviderFcUsesBatch
              ? phoneProviderFcAllowedItemTypes
              : privateChatProviderFcAllowedItemTypes,
            allowedStickerKeywords: privateChatProviderFcAllowedStickerKeywords,
            formatMode: phoneJsonTerminalRoute.formatMode,
            schema: phoneJsonTerminalRoute.schema,
            stream: Boolean(config?.stream),
            maxTokens: structuredMaxTokens,
            signal: abortController.signal,
            requestOptions: requestPayloadOptions,
            onProviderUsage: requestOptions.onProviderUsage,
            onFirstProviderDelta: markFirstProviderDelta,
          });
        } else {
          const sharedPhoneProviderFcAttemptOptions = {
            enabled: true,
            client: requestClient,
            config,
            messages: phoneProviderFcRoute.messages,
            context: phoneProviderFcContext,
            thinkingEnabled: phoneStructuredEffectiveThinkingEnabled,
            temperature: Number.isFinite(configuredTemperature) ? configuredTemperature : 0.7,
            maxTokens: structuredMaxTokens,
            signal: abortController.signal,
            requestOptions: requestPayloadOptions,
            onProviderUsage: requestOptions.onProviderUsage,
            allowedItemTypes: phoneProviderFcAllowedItemTypes,
            allowedStickerKeywords: privateChatProviderFcAllowedStickerKeywords,
            streamPreviewEnabled: phoneProviderFcStreamPreviewEnabled,
            onStructuredPreview: phoneStructuredPreviewCallback,
            onFirstProviderDelta: markFirstProviderDelta,
            probationMode: phoneStructuredRouteDecision.layer !== 'verified_native_fc',
            preparedProviderRequestPlan: phoneProviderFcRequestPlan,
          };
          phoneStructuredAttempt = phoneProviderFcUsesBatch
            ? await runPhoneBatchProviderFcAttempt({
                ...sharedPhoneProviderFcAttemptOptions,
                target: phoneBatchProviderFcTarget,
                capabilities: phoneTransportPlan.structuredCapabilities || {},
              })
            : await runPrivateChatProviderFcAttempt({
                ...sharedPhoneProviderFcAttemptOptions,
                target: privateChatProviderFcTarget,
              });
        }
        const structuredFailure = phoneStructuredAttempt.ok
          ? null
          : classifyChatStructuredAttemptFailure(phoneStructuredAttempt);
        phoneStructuredAttempt.diagnostics = {
          ...(phoneStructuredAttempt.diagnostics || {}),
          thinkingRequested: phoneStructuredThinkingPlan.thinkingRequested,
          thinkingEnabled: phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal
            ? phoneStructuredThinkingPlan.thinkingRequested
            : phoneStructuredThinkingPlan.thinkingEnabled,
          thinkingOverrideReason: phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.providerFc
            ? phoneStructuredThinkingPlan.thinkingOverrideReason
            : '',
        };
        finishProviderCall(phoneStructuredAttempt.ok
          ? 'succeeded'
          : (structuredFailure.fallbackAllowed === true ? 'fallback' : 'failed'));
        let localRuleHealthTransition = null;
        if (
          phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.providerFc
          && phoneProviderFcRelease.capabilityLayer === 'local_advanced'
          && phoneProviderFcRelease.capabilityRuleId
        ) {
          try {
            localRuleHealthTransition = await chatFcLocalCapabilityStore.recordAttempt(
              phoneProviderFcRelease.capabilityRuleId,
              phoneStructuredAttempt,
            );
          } catch (error) {
            logger.warn('本地 FC 规则健康状态保存失败', error);
          }
        }
        const structuredEvidenceIdentityResult = phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal
          ? phoneJsonEvidenceIdentityResult
          : phoneProviderFcEvidenceIdentityResult;
        let structuredEvidenceTransition = null;
        if (!phoneStructuredAttempt.ok && structuredEvidenceIdentityResult.ok) {
          try {
            structuredEvidenceTransition = await chatStructuredRouteEvidenceStore.record(
              structuredEvidenceIdentityResult.identity,
              phoneStructuredRouteMode,
              {
                ...phoneStructuredAttempt,
              },
            );
          } catch (error) {
            logger.warn('结构化路由失败证据保存失败', error);
          }
        }
        if (!phoneStructuredAttempt.ok && phoneStructuredHalfOpenLeaseHeld) {
          chatStructuredRouteEvidenceStore.releaseHalfOpenRequest(nativeRequestId);
          phoneStructuredHalfOpenLeaseHeld = false;
        }
        if (['circuit_opened', 'negative_capability_recorded'].includes(structuredEvidenceTransition?.action)) {
          emitPhoneStructuredRouteStatus('circuit_opened', {
            message: '该模型的回复格式连续失败，已切换为传统模式。可在 API 设置中查看或重试。',
            evidenceKey: String(structuredEvidenceTransition?.cell?.key || ''),
            localRuleId: String(
              phoneProviderFcRelease.capabilityLayer === 'local_advanced'
                ? phoneProviderFcRelease.capabilityRuleId
                : '',
            ),
            circuitEpoch: Number(structuredEvidenceTransition?.cell?.health?.circuitEpoch || 0),
            circuitOpenedAt: Number(structuredEvidenceTransition?.cell?.health?.circuitOpenedAt || 0),
          });
        }
        if (this.lastRequest?.requestId === nativeRequestId) {
          const localRuleHealth = localRuleHealthTransition?.rule?.health;
          const evidenceHealth = structuredEvidenceTransition?.cell?.health;
          this.lastRequest.phoneReplyTransport = {
            ...(this.lastRequest.phoneReplyTransport || {}),
            attempted: phoneStructuredAttempt.attempted === true,
            effectiveMode: phoneStructuredAttempt.ok
              ? phoneStructuredRouteMode
              : (phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal
                  ? 'json_fallback'
                  : 'fc_fallback'),
            fallbackReason: phoneStructuredAttempt.ok
              ? ''
              : String(phoneStructuredAttempt.reason || `${phoneStructuredRouteMode}_failed`),
            toolCallCount: Number(phoneStructuredAttempt.diagnostics?.toolCallCount || 0),
            validationErrorCount: Number(phoneStructuredAttempt.diagnostics?.validationErrorCount || 0),
            validationErrorCodes: Array.isArray(phoneStructuredAttempt.diagnostics?.validationErrorCodes)
              ? phoneStructuredAttempt.diagnostics.validationErrorCodes.slice(0, 20)
              : [],
            failureShape: phoneStructuredAttempt.diagnostics?.failureShape || null,
            argumentRepairApplied: phoneStructuredAttempt.diagnostics?.argumentRepairApplied === true,
            argumentRepairKinds: Array.isArray(phoneStructuredAttempt.diagnostics?.argumentRepairKinds)
              ? phoneStructuredAttempt.diagnostics.argumentRepairKinds.slice(0, 20)
              : [],
            thinkingRequested: phoneStructuredThinkingPlan.thinkingRequested === true,
            thinkingEnabled: phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal
              ? phoneStructuredThinkingPlan.thinkingRequested === true
              : phoneStructuredThinkingPlan.thinkingEnabled === true,
            thinkingOverrideReason: String(phoneStructuredAttempt.diagnostics?.thinkingOverrideReason || ''),
            streamPreviewUsed: phoneStructuredAttempt.diagnostics?.streamPreviewUsed === true,
            previewUpdateCount: Number(phoneStructuredAttempt.diagnostics?.previewUpdateCount || 0),
            previewChars: Number(phoneStructuredAttempt.diagnostics?.previewChars || 0),
            previewFieldCount: Number(phoneStructuredAttempt.diagnostics?.previewFieldCount || 0),
            previewTruncated: phoneStructuredAttempt.diagnostics?.previewTruncated === true,
            firstPreviewLatencyMs: Number(phoneStructuredAttempt.diagnostics?.firstPreviewLatencyMs || 0),
            evidenceStatus: String(evidenceHealth?.status || this.lastRequest.phoneReplyTransport?.evidenceStatus || ''),
            evidenceStrictSuccessCount: Number(
              evidenceHealth?.strictSuccessCount
              ?? this.lastRequest.phoneReplyTransport?.evidenceStrictSuccessCount
              ?? 0,
            ),
            circuitOpen: evidenceHealth?.circuitOpen === true,
            cooldownUntil: Number(evidenceHealth?.cooldownUntil || 0),
            evidenceAction: String(structuredEvidenceTransition?.action || ''),
            localRuleCircuitOpen: localRuleHealth?.circuitOpen === true,
            localRuleFailureCount: Number(
              localRuleHealth?.consecutiveDeterministicFailures
              ?? this.lastRequest.phoneReplyTransport?.localRuleFailureCount
              ?? 0,
            ),
            localRuleLastFailureReason: String(
              localRuleHealth?.lastFailureReason
              ?? this.lastRequest.phoneReplyTransport?.localRuleLastFailureReason
              ?? '',
            ),
            localRuleHealthAction: String(localRuleHealthTransition?.action || ''),
          };
        }
        if (phoneStructuredAttempt.ok) {
          const structuredRaw = String(phoneStructuredAttempt.raw || '');
          completeGenerationDiagnostics({ stream: structuredCallStream });
          try {
            await this.saveToHistory(originalInput, structuredRaw);
          } catch (error) {
            if (phoneStructuredHalfOpenLeaseHeld) {
              chatStructuredRouteEvidenceStore.releaseHalfOpenRequest(nativeRequestId);
              phoneStructuredHalfOpenLeaseHeld = false;
            }
            throw error;
          }
          if (structuredEvidenceIdentityResult.ok) {
            const responseModel = String(
              this.lastRequest?.responseDiagnostics?.responseModel || '',
            ).trim().toLowerCase();
            const systemFingerprint = String(
              this.lastRequest?.responseDiagnostics?.systemFingerprint || '',
            ).trim();
            const requestedModel = String(config?.model || '').trim().toLowerCase();
            this.chatStructuredEvidenceCommitRuntime.stage({
              requestId: nativeRequestId,
              identity: structuredEvidenceIdentityResult.identity,
              mode: phoneStructuredRouteMode,
              outcome: {
                ...phoneStructuredAttempt,
                argumentRepairApplied: phoneStructuredAttempt.diagnostics?.argumentRepairApplied === true,
                canonicalRoundTrip: phoneStructuredAttempt.canonicalRoundTrip !== false,
                frozenTargetMatched: phoneStructuredAttempt.frozenTargetMatched !== false,
                domainValidated: phoneStructuredAttempt.domainValidated !== false,
                responseIdentityStable: !responseModel || responseModel === requestedModel,
                responseModel,
                systemFingerprint,
                latencyMs: phoneStructuredAttempt.diagnostics?.latencyMs,
              },
            });
          }
          emitPhoneStructuredRouteStatus('complete', { message: '' });
          if (config.stream) {
            return (async function* () {
              if (structuredRaw) yield structuredRaw;
            })();
          }
          return structuredRaw;
        }

        if (structuredFailure.fallbackAllowed !== true) {
          emitPhoneStructuredRouteStatus('failed', {
            message: structuredFailure.category === 'configuration'
              ? '结构化请求的凭证或权限有误，请检查 API 设置。'
              : '结构化请求失败。',
            reason: structuredFailure.reason,
          });
          const error = new Error(structuredFailure.category === 'configuration'
            ? 'API 凭证或权限错误，已停止回退以免掩盖配置问题。'
            : `结构化请求失败：${structuredFailure.reason}`);
          error.code = structuredFailure.category === 'configuration'
            ? 'structured_provider_configuration_error'
            : 'structured_provider_request_failed';
          error.status = structuredFailure.httpStatus || 0;
          throw error;
        }
        emitPhoneStructuredRouteStatus('fallback', {
          message: '当前格式未通过，正在以传统格式重试…',
          reason: structuredFailure.reason,
          additionalProviderCalls: 1,
        });

        // 结构化 primary 尚未向 APP 返回任何内容，故仍位于唯一持久提交边界之前；
        // 从同一冻结语义快照恢复文本传输层，不重跑 prompt builder 或 hook。
        const lazyLegacyAssembly = assembleLegacyTextRequest(phoneProviderFcRoute.semanticSnapshot);
        if (!lazyLegacyAssembly.ok) {
          throw new Error(`Structured fallback snapshot unavailable: ${lazyLegacyAssembly.reason}`);
        }
        messages = lazyLegacyAssembly.messages;
        const fallbackPreparedRequest = generationClient?.prepareChatRequest?.(messages, { ...requestOptions, stream: Boolean(config?.stream) }) || null;
        const fallbackRequestMessages = fallbackPreparedRequest?.messages || messages;
        responsePrefix = String(fallbackPreparedRequest?.responsePrefix || legacyResponsePrefix);
        rawEstimatedPromptTokens = estimatePromptMessagesTokens(fallbackRequestMessages, 'rough');
        calibrationEligible = config?.webSearchEnabled !== true
          && !promptMessagesContainNonTextContent(fallbackRequestMessages);
        calibrationRecorded = false;
        this.lastGenerationUsage = null;
        this.lastGenerationSources = null;
        const fallbackInjectionAudit = buildRequestInjectionAudit({
          memoryPlan: this.lastMemoryPlan,
          extraSegments: globalPromptAuditSegments,
          history: nextContext?.history,
          worldDebug: this.lastWorldInjectionDebug,
          messages: fallbackRequestMessages,
          budget: this.lastMemoryPlan?.budget,
          mode: this.lastMemoryPlan?.budget?.mode,
          tokenMode: requestTokenMode,
        });
        fallbackInjectionAudit.calibration = { ...requestCalibration };
        fallbackInjectionAudit.coverageLine = this.lastMemoryPlan?.coverageLine || null;
        fallbackInjectionAudit.historyBudgetStats = this.lastMemoryPlan?.historyBudgetStats || null;
        fallbackInjectionAudit.globalPrompt = globalPromptAudit;
        if (this.lastMemoryPlan && typeof this.lastMemoryPlan === 'object') {
          this.lastMemoryPlan = {
            ...this.lastMemoryPlan,
            requestAudit: fallbackInjectionAudit,
          };
        }
        if (this.lastRequest?.requestId === nativeRequestId) {
          this.lastRequest.stream = Boolean(config?.stream);
          this.lastRequest.options = fallbackPreparedRequest?.normalizedOptions || genOptions;
          if (fallbackPreparedRequest?.body) this.lastRequest.wireRequest = {
            url: sanitizeRequestPreviewUrl(fallbackPreparedRequest.url), body: fallbackPreparedRequest.body,
            parameterReport: fallbackPreparedRequest.parameterReport || [],
          };
          this.lastRequest.requestOptions = {
            ...withRuntimeParamConstraints({
              ...(genOptions || {}),
              ...(providerDirectives || {}),
              ...(providerToolRequestSchema.requestOptions || {}),
              ...(webSearchPlan.requestOptions || {}),
            }),
          };
          this.lastRequest.deepSeekPhonePrefill = phonePrefillPlan.diagnostics;
          this.lastRequest.messages = fallbackRequestMessages;
          this.lastRequest.responsePrefix = responsePrefix;
          this.lastRequest.injectionAudit = fallbackInjectionAudit;
          this.lastRequest.phoneReplyTransport = {
            ...(this.lastRequest.phoneReplyTransport || {}),
            effectiveMode: phoneStructuredRouteMode === CHAT_STRUCTURED_ROUTE_MODES.jsonTerminal
              ? 'json_fallback'
              : 'fc_fallback',
            snapshotFingerprint: lazyLegacyAssembly.snapshotFingerprint,
            fallbackAssembly: 'lazy_legacy_from_snapshot',
            budgetRecomputed: lazyLegacyAssembly.diagnostics?.budgetRecomputed === true,
          };
          resetResponseForNextProviderCall();
          this.lastRequest.lineageTrace = buildPromptTraceFromRequest(this.lastRequest, {
            requestId: nativeRequestId,
            scopeId: this.scopeId || sessionId,
          });
          this.lastRequest.promptCacheDebug = this.emitPromptCacheDebug(
            sessionId,
            fallbackRequestMessages,
            {
              provider: config?.provider,
              model: config?.model,
              stream: Boolean(config?.stream),
              requestId: nativeRequestId,
            },
          );
        }
      }

      if (config.stream) {
        const legacyMode = getProviderCalls().length ? 'legacy_text_fallback' : 'legacy_text';
        startProviderCall(legacyMode, true);
        streaming = true;
        const inner = this.generateStream(messages, requestOptions, originalInput, {
          responsePrefix,
          client: generationClient,
          config,
          requestId: nativeRequestId,
          requestStartedAt: generationStartedAt,
          onFirstMeaningfulDelta: markFirstProviderDelta,
          onProviderCallFinished: ({ outcome = 'succeeded', completedAt = Date.now() } = {}) => {
            finishProviderCall(outcome, completedAt);
            completeGenerationDiagnostics({ completedAt, stream: true });
            emitPhoneStructuredRouteStatus(outcome === 'succeeded' ? 'complete' : 'failed', { message: '' });
          },
        });
        return (async function* () {
          try {
            yield* inner;
          } finally {
            releaseGenerationLock();
          }
        })();
      } else {
        const legacyMode = getProviderCalls().length ? 'legacy_text_fallback' : 'legacy_text';
        let legacyAttempt = 0;
        const response = await retryWithBackoff(async () => {
          if (legacyAttempt > 0) resetResponseForNextProviderCall();
          const mode = legacyAttempt > 0 ? `${legacyMode}_retry` : legacyMode;
          legacyAttempt += 1;
          startProviderCall(mode, false);
          try {
            return await generationClient.chat(messages, requestOptions);
          } catch (error) {
            finishProviderCall(abortController.signal.aborted ? 'cancelled' : 'failed');
            throw error;
          }
        }, {
          maxRetries: getProviderCalls().length > 0 ? 0 : (config.maxRetries || 3),
          shouldRetry: err => !abortController.signal.aborted && isRetryableError(err),
        });
        if (abortController.signal.aborted) {
          finishProviderCall('cancelled');
          throw makeCancelledError('user');
        }
        finishProviderCall('succeeded');
        const finalResponse = this.mergeAssistantPrefillResponse(responsePrefix, response);

        completeGenerationDiagnostics({ stream: false });

        // 保存到历史记录
        await this.saveToHistory(originalInput, finalResponse);
        emitPhoneStructuredRouteStatus('complete', { message: '' });
        return finalResponse;
      }
    } catch (error) {
      if (activeProviderCallId) {
        finishProviderCall(abortController.signal.aborted ? 'cancelled' : 'failed');
      }
      completeGenerationDiagnostics({ stream: Boolean(config?.stream) });
      if (abortController.signal.aborted) {
        throw makeCancelledError('user');
      }
      logger.error('生成失败:', error);
      throw error;
    } finally {
      if (previewOnly) {
        this.lastMemoryPlan = previousLastMemoryPlan;
        this.lastRequest = previousLastRequest;
        this.lastGenerationUsage = previousLastGenerationUsage;
        this.lastGenerationSources = previousLastGenerationSources;
        this.lastWorldInjectionDebug = previousLastWorldInjectionDebug;
        this.lastDeepSeekFormatDebug = previousLastDeepSeekFormatDebug;
        this.lastPhoneFormatTransportPlan = previousLastPhoneFormatTransportPlan;
        this.lastPromptSegmentDebug = previousLastPromptSegmentDebug;
        this.activeInputBudgetPlan = previousActiveInputBudgetPlan;
        this.activeTokenEstimateMode = previousActiveTokenEstimateMode;
        if (hadPreviousPromptCacheDebug) {
          this.lastPromptCacheDebugBySession?.set?.(previewSessionId, previousPromptCacheDebug);
        } else {
          this.lastPromptCacheDebugBySession?.delete?.(previewSessionId);
        }
      }
      if (!streaming) {
        releaseGenerationLock();
      }
    }
  }

  /**
   * Background one-shot chat (does not block main generation / no isGenerating lock).
   * Intended for maintenance tasks like summary compaction.
   */
  async backgroundChat(messages, options = {}) {
    const requestContext = captureRequestContext(options.requestContext || {
      scopeId: this.scopeId,
      sessionId: options.presetContext?.sessionId || this.activeSessionId,
      archiveId: this.chatStore?.getCurrentArchiveId?.(options.presetContext?.sessionId || this.activeSessionId),
    });
    if (!this.initialized) {
      await this.init();
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new Error('当前离线，请连接网络后再试');
    }
    const msgs = Array.isArray(messages) ? messages : [];
    if (!msgs.length) throw new Error('messages 不能为空');

    // Use the same generation options mapping as normal chat, but allow caller overrides.
    const { presetContext = null, runtimeConfigOverride = null, ...requestOverrides } = options || {};
    const resolvedPresetContext = presetContext || {
      sessionId: String(this.activeSessionId || '').trim(),
      uiMode: String(this.activeSessionId || '').trim().startsWith('rp:') ? 'rp' : 'chat',
    };
    const hasRuntimeConfigOverride = runtimeConfigOverride && typeof runtimeConfigOverride === 'object';
    const requestRuntime = hasRuntimeConfigOverride
      ? null
      : await this.resolveRequestRuntimeConfig(resolvedPresetContext);
    const baseConfig = requestRuntime?.config || this.config.get?.() || {};
    const config = hasRuntimeConfigOverride
      ? { ...baseConfig, ...runtimeConfigOverride }
      : baseConfig;
    const canUseAnonymousCustomApi = config.provider === 'custom' && Boolean(String(config.baseUrl || '').trim());
    const requestClient = hasRuntimeConfigOverride
      ? ((canInitClient(config) || canUseAnonymousCustomApi) ? new LLMClient(config) : null)
      : (requestRuntime?.client || (canInitClient(config) ? new LLMClient(config) : null));
    if (!requestClient) {
      throw new Error('请先配置 API 信息');
    }
    const genOptions = {
      ...this.getGenerationOptions(resolvedPresetContext, config),
      ...requestOverrides,
      requestContext,
    };
    const normalizedMsgs = this.normalizeOutgoingProviderMessages(msgs, config);
    return requestClient.chat(normalizedMsgs, genOptions);
  }

  /**
   * 流式生成
   */
  async *generateStream(messages, genOptions = {}, originalUserMessage = '', streamMeta = {}) {
    let fullResponse = '';
    const responsePrefix = String(streamMeta?.responsePrefix || '');
    const requestClient = streamMeta?.client || this.client;
    const streamConfig = streamMeta?.config && typeof streamMeta.config === 'object'
      ? streamMeta.config
      : (this.config?.get?.() || {});
    const requestId = String(streamMeta?.requestId || genOptions?.nativeRequestId || '').trim();
    const requestStartedAt = Number(streamMeta?.requestStartedAt) || Date.now();
    const onFirstMeaningfulDelta = typeof streamMeta?.onFirstMeaningfulDelta === 'function'
      ? streamMeta.onFirstMeaningfulDelta
      : null;
    const onProviderCallFinished = typeof streamMeta?.onProviderCallFinished === 'function'
      ? streamMeta.onProviderCallFinished
      : null;
    let providerCallFinished = false;
    const finishProviderCall = (outcome, completedAt = Date.now()) => {
      if (providerCallFinished) return;
      providerCallFinished = true;
      try { onProviderCallFinished?.({ outcome, completedAt }); } catch {}
    };

    try {
      if (!requestClient?.streamChat) {
        throw new Error('请先配置 API 信息');
      }
      const stream = requestClient.streamChat(messages, genOptions);
      const bridge = this;
      const measuredStream = (async function* () {
        for await (const chunk of stream) {
          const meaningfulTextDelta = isMeaningfulTextStreamDelta(chunk);
          if (meaningfulTextDelta) {
            try { onFirstMeaningfulDelta?.({ at: Date.now() }); } catch {}
          }
          if (
            meaningfulTextDelta
            && bridge.lastRequest?.requestId === requestId
            && !bridge.lastRequest.responseDiagnostics?.firstMeaningfulDeltaAt
            && !bridge.lastRequest.responseDiagnostics?.firstTokenAt
          ) {
            bridge.lastRequest.responseDiagnostics = buildFirstTokenResponseDiagnostics(
              bridge.lastRequest.responseDiagnostics,
              {
                requestStartedAt,
                firstTokenAt: Date.now(),
                stream: true,
              },
            );
          }
          yield chunk;
        }
      })();
      for await (const chunk of this.applyAssistantPrefillToStream(measuredStream, responsePrefix)) {
        if (!isReasoningStreamEvent(chunk)) {
          fullResponse += String(chunk ?? '');
        }
        yield chunk;
      }

      const completedAt = Date.now();
      finishProviderCall('succeeded', completedAt);

      if (!onProviderCallFinished && this.lastRequest?.requestId === requestId && !this.lastRequest.responseDiagnostics?.completedAt) {
        this.lastRequest.responseDiagnostics = buildCompletedResponseDiagnostics(
          this.lastRequest.responseDiagnostics,
          {
            requestStartedAt,
            completedAt,
            usage: this.lastGenerationUsage,
            stream: true,
          },
        );
      }

      // 流式完成后保存到历史记录
      await this.saveToHistory(originalUserMessage || '', fullResponse);
    } catch (error) {
      // User-initiated cancellation (e.g. message retract) should not be converted into a timeout error.
      if (shouldTreatBridgeStreamErrorAsCancellation(error, {
        signal: genOptions?.signal || null,
        abortReason: this.abortReason,
      })) {
        finishProviderCall('cancelled');
        throw makeCancelledError(resolveBridgeCancellationReason({
          signal: genOptions?.signal || null,
          abortReason: this.abortReason,
        }));
      }
      const normalized = (() => {
        try {
          // Android WebView may throw DOMException on abort/timeout
          const name = String(error?.name || '');
          const msg = String(error?.message || '');
          if (isBridgeAbortError(error)) {
            const ms = Number(streamConfig?.timeout);
            const sec = Number.isFinite(ms) ? Math.round(ms / 1000) : 60;
            const e = new Error(`请求超时（${sec}秒），请稍后重试或在 API 设定中调低输出/切换网络`);
            e.cause = error;
            return e;
          }
          if (error instanceof DOMException) {
            const e = new Error(`${name || 'DOMException'}${msg ? `: ${msg}` : ''}`);
            e.cause = error;
            return e;
          }
        } catch {}
        return error;
      })();
      if (isRecoverableNativeStreamTailError(normalized, fullResponse)) {
        logger.warn('流式收尾解码失败，但已收到正文；保留已生成内容', normalized?.message);
        finishProviderCall('succeeded');
        await this.saveToHistory(originalUserMessage || '', fullResponse);
        return;
      }
      finishProviderCall('failed');
      logger.error('流式生成失败:', normalized?.name, normalized?.message, normalized);
      throw normalized;
    }
  }

  normalizeOutgoingProviderMessages(messages, config = null, meta = {}) {
    let list = Array.isArray(messages) ? messages : [];
    if (!list.length) return list;

    const cfg = config || this.config?.get?.() || {};
    const provider = String(cfg?.provider || '').trim().toLowerCase();
    const promptPostProcessing = normalizePromptPostProcessingMode(cfg?.promptPostProcessing);
    const providerRejectsAssistantPrefill = provider === 'anthropic';
    const providerCompatLabel = provider === 'anthropic' ? 'Anthropic' : (provider || 'Provider');
    const syntheticAssistantDowngradeCount = Math.max(0, Math.trunc(Number(meta?.syntheticAssistantDowngradeCount) || 0));

    const normalizeRole = (role) => {
      const r = String(role || '').trim().toLowerCase();
      return r === 'user' || r === 'assistant' || r === 'system' ? r : 'system';
    };
    const stringifyContent = (content) => {
      if (Array.isArray(content)) {
        return content
          .map(part => (part?.type === 'text' ? String(part.text || '') : ''))
          .filter(Boolean)
          .join('\n');
      }
      return String(content ?? '');
    };
    const trimEdgeBlankLines = (text) =>
      String(text ?? '').replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:\r?\n[ \t]*)+$/, '');
    const joinBlocks = (blocks = []) => {
      const parts = Array.isArray(blocks) ? blocks : [blocks];
      return parts.map(trimEdgeBlankLines).filter(s => String(s || '').trim().length > 0).join('\n\n');
    };
    const summarizeTailRoles = (limit = 8) =>
      list
        .slice(-limit)
        .map((msg, idx) => {
          const absoluteIdx = Math.max(0, list.length - limit) + idx;
          const role = normalizeRole(msg?.role || 'system');
          const preview = stringifyContent(msg?.content).replace(/\s+/g, ' ').trim().slice(0, 40) || '(empty)';
          return `${absoluteIdx}:${role}:${preview}`;
        })
        .join(' | ');

    if (promptPostProcessing !== 'none') {
      const processedMessages = applyPromptPostProcessing(list, promptPostProcessing);
      if (processedMessages !== list) {
        list = processedMessages;
        const compatMsg = `${providerCompatLabel} 提示词后处理：已应用 ${promptPostProcessing}。tail=${summarizeTailRoles()}`;
        logger.debug(compatMsg);
        emitDebugLog({ source: 'prompt', type: 'info', message: compatMsg });
      }
    }

    if (syntheticAssistantDowngradeCount > 0) {
      const compatMsg = `${providerCompatLabel} 兼容：已将 ${syntheticAssistantDowngradeCount} 个合成 assistant 提示词改为 system。tail=${summarizeTailRoles()}`;
      logger.debug(compatMsg);
      emitDebugLog({ source: 'prompt', type: 'info', message: compatMsg });
    }

    const lastNonSystem = [...list].reverse().find((msg) => normalizeRole(msg?.role || 'system') !== 'system');
    if (providerRejectsAssistantPrefill && normalizeRole(lastNonSystem?.role || 'system') === 'assistant') {
      list.push({ role: 'user', content: ' ' });
      const fallbackMsg = `${providerCompatLabel} 兼容：检测到尾部 assistant 消息，已补空白 user turn。tail=${summarizeTailRoles()}`;
      logger.warn(fallbackMsg);
      emitDebugLog({ source: 'prompt', type: 'warn', message: fallbackMsg });
    }

    return list;
  }

  /**
   * 构建消息数组
   */
	  buildMessages(userMessage, context = {}, options = {}) {
	    const messages = [];
    const deferPhoneTransportLayers = options?.deferPhoneTransportLayers === true;
    const transportAnchorNamespace = String(options?.transportAnchorNamespace || 'request')
      .replace(/[^a-zA-Z0-9._-]/g, '')
      .slice(0, 80) || 'request';
    const deferredLegacyLayers = [];
    const createTransportAnchorMarker = id => (
      `\uE000chat-semantic:${transportAnchorNamespace}:${String(id || '').trim()}\uE001`
    );
    this.lastWorldInjectionDebug = null;
    this.lastDeepSeekFormatDebug = null;
    this.lastPhoneFormatTransportPlan = null;
    this.lastPromptSegmentDebug = null;
    this.lastGlobalSemanticPromptAudit = null;

    const name1 = context?.user?.name || 'user';
    const name2 = context?.character?.name || 'assistant';
    const sessionIdForSummary = String(context?.session?.id || this.activeSessionId || 'default');
    const suppressPendingUserTurn = context?.meta?.suppressPendingUserTurn === true;
    const rawUserMessage = (typeof context?.meta?.rawUserMessage === 'string')
      ? String(context.meta.rawUserMessage)
      : String(userMessage ?? '');
    const pendingUserTextRaw = suppressPendingUserTurn ? '' : String(rawUserMessage ?? '').trim();
    const appendUserToHistory = context?.meta?.appendUserToHistory !== false;
    const isMomentCommentTask = String(context?.task?.type || '').toLowerCase() === 'moment_comment';
    const momentCommentTaskMode = String(context?.task?.mode || '').trim().toLowerCase();
    const isPublishedMomentCommentTask =
      isMomentCommentTask &&
      (momentCommentTaskMode === 'published_moment' ||
        momentCommentTaskMode === 'moment_publish' ||
        momentCommentTaskMode === 'publish_comment');
    const explicitlyDisablePhoneFormat = Boolean(context?.meta?.disablePhoneFormat);
    const suppressGenericReplyPrompt = isMomentCommentTask;
    const sessionId = String(context?.session?.id || '').trim();
    const variableRuntimeEnabled = this.isVariableRuntimeEnabled?.(sessionId) !== false
      && (!Array.isArray(context?.meta?.hopscotchFused) || context.meta.hopscotchFused.includes('variable'));
    const uiModeRaw = String(context?.meta?.uiMode || context?.uiMode || '').trim().toLowerCase();
    const uiMode = uiModeRaw === 'rp' || (!uiModeRaw && sessionId.startsWith('rp:')) ? 'rp' : 'chat';
    const presetUiMode = normalizeBridgePresetUiMode(uiModeRaw, {
      sessionId,
      taskType: context?.task?.type,
    });
    const historyRecallNotice = isMomentCommentTask
      ? (isPublishedMomentCommentTask
        ? getLocalizedPromptText('history_recall.published_moment')
        : getLocalizedPromptText('history_recall.moment_comment'))
      : getLocalizedPromptText('history_recall.chat');
    const isGroupChat = Boolean(context?.session?.isGroup) || sessionId.startsWith('group:');
    const preserveCreativeHistoryParagraphs = uiModeRaw === 'rp';
    const memoryMode = String(context?.meta?.memoryStorageMode || '').trim().toLowerCase();
    const useSummaryMemory = memoryMode === 'summary' && !Boolean(context?.meta?.disableSummary);
    const presetState = this.presets?.getState?.() || null;
    const useSysprompt = Boolean(presetState?.enabled?.sysprompt);
    const useContext = Boolean(presetState?.enabled?.context);
    const useOpenAIPreset = Boolean(presetState?.enabled?.openai);
    const presetContext = { sessionId, uiMode: presetUiMode };
    const resolveAgentPreset = (actionName = '', resolved = null) => {
      const preset = resolved?.preset || null;
      if (!preset || typeof preset !== 'object') return preset;
      const action = this.debugUiRegistry?.actions?.[actionName];
      if (typeof action !== 'function') return preset;
      try {
        const next = action({
          presetId: String(resolved?.presetId || '').trim(),
          preset,
          sessionId,
          uiMode: presetUiMode,
        });
        return next && typeof next === 'object' ? next : preset;
      } catch {
        return preset;
      }
    };
    const syspResolved = this.presets.getResolvedActive('sysprompt', presetContext) || null;
    const syspActive = resolveAgentPreset('resolveAgentSyspromptPresetSync', syspResolved);
    const sysp = useSysprompt ? syspActive : null;
    const ctxp = useContext ? (this.presets.getResolvedActive('context', presetContext)?.preset || null) : null;
    const openaiResolved = this.presets.getResolvedActive('openai', presetContext) || null;
    const activeOpenAIPreset = resolveAgentPreset('resolveAgentOpenAIPresetSync', openaiResolved);
    const openp = useOpenAIPreset ? activeOpenAIPreset : null;
    const openAIFormatReminderState = resolveOpenAIPresetFormatReminderState(openaiResolved, activeOpenAIPreset);
    const activeOpenAIPresetId = openAIFormatReminderState.presetId;
    const activeOpenAIPresetName = openAIFormatReminderState.presetName;
    const isDefaultOpenAIPreset = openAIFormatReminderState.isDefaultPreset;
    const globalSemanticPromptLibrary = (() => {
      try {
        const action = this.debugUiRegistry?.actions?.getAgentCenterSettings;
        const settings = typeof action === 'function' ? action() : null;
        return settings?.global?.semanticPromptLibrary || null;
      } catch {
        return null;
      }
    })();
    const globalSemanticPromptPlan = resolveGlobalSemanticPromptPlan(
      globalSemanticPromptLibrary,
      {
        scope: 'chat',
        taskType: String(context?.task?.type || '').trim(),
        uiMode,
        hasCustomChatPreset: openaiResolved?.hasCustomBinding === true,
        user: name1,
        char: name2,
        now: new Date(),
      },
    );
    this.lastGlobalSemanticPromptAudit = buildGlobalSemanticPromptInjectionAudit(
      globalSemanticPromptPlan,
    );
    const replyTarget = resolvePresetReplyTarget(activeOpenAIPreset, presetUiMode, context?.meta?.responseTarget);
    const disablePhoneFormat = explicitlyDisablePhoneFormat || isMomentCommentTask || replyTarget === 'user';
    const settingsSnapshot = (() => {
      try {
        return appSettings.get();
      } catch {
        return {};
      }
    })();
    const includeTimeContext = (() => {
      const raw = context?.meta?.includeTimeContext;
      if (typeof raw === 'boolean') return raw;
      return settingsSnapshot.promptCurrentTimeEnabled === true;
    })();
    const timeContextBlock = includeTimeContext ? { role: 'system', content: buildTimeContextText() } : null;
    const parseInjectedPrompt = (rawPrompt, fallbackPositions = ['after_persona'], fallbackDepth = 0) => {
      const content = typeof rawPrompt?.content === 'string' ? String(rawPrompt.content).trim() : '';
      if (!content) return null;
      const positionRaw = rawPrompt?.position ?? '';
      const parsed = parseMemoryPromptPositions(positionRaw);
      const positions = parsed.length ? parsed : fallbackPositions;
      const depthRaw = Math.trunc(Number(rawPrompt?.depth));
      const depth = Number.isFinite(depthRaw) ? Math.max(0, depthRaw) : fallbackDepth;
      const roleRaw = String(rawPrompt?.role || 'system').toLowerCase();
      const role =
        roleRaw === 'user' || roleRaw === 'assistant' || roleRaw === 'system'
          ? roleRaw
          : 'system';
      return { content, positions, role, depth };
    };
    const memoryGuidePrompt = parseInjectedPrompt(context?.meta?.memoryGuidePrompt, ['before_latest_user'], 0);
    const memoryPrompt = parseInjectedPrompt(context?.meta?.memoryPrompt, ['before_latest_user'], 0);
    const disableScenarioHint = Boolean(context?.meta?.disableScenarioHint);
    const replyPromptHint = String(context?.meta?.replyPromptHint || '').trim();
    const overrideLastUserMessageRaw = (typeof context?.meta?.overrideLastUserMessage === 'string')
      ? String(context.meta.overrideLastUserMessage)
      : '';
    const scenarioSessionName = String(context?.session?.name || '').trim();
    const scenarioCharacterName = String(context?.character?.name || '').trim();
    const formatGroupName = String(
      context?.group?.name || scenarioSessionName || scenarioCharacterName || context?.session?.id
        || getLocalizedPromptText('transport.fallback_group_name'),
    ).trim();
    const formatPrivateTargetName = String(
      scenarioSessionName || scenarioCharacterName || context?.session?.id
        || getLocalizedPromptText('transport.fallback_private_target'),
    ).trim();
    const scenarioHintBase = (() => {
      if (disableScenarioHint) return '';
      if (isMomentCommentTask) {
        if (isPublishedMomentCommentTask) {
          return getLocalizedPromptText('transport.scenario_published_moment_comment');
        }
        const isReply = Boolean(context?.task?.replyToAuthor) || Boolean(context?.task?.replyToCommentId) || Boolean(context?.task?.isReplyToComment);
        return getLocalizedPromptText(isReply ? 'transport.scenario_moment_comment_reply' : 'transport.scenario_moment_comment');
      }
      if (isGroupChat) {
        return getLocalizedPromptText('transport.scenario_group').split('{name}').join(formatGroupName);
      }
      return getLocalizedPromptText('transport.scenario_private').split('{name}').join(formatPrivateTargetName);
    })();
    const scenarioFormatReminder = scenarioHintBase
      ? scenarioHintBase
      : '';
    const uiModeRawForAutoImage = String(context?.meta?.uiMode || context?.uiMode || '').trim().toLowerCase();
    const autoImagePromptWritingAllowed = Array.isArray(context?.meta?.hopscotchFused)
      ? context.meta.hopscotchFused.includes('image_prompt')
      : (uiModeRawForAutoImage === 'rp' ? settingsSnapshot.autoImagePromptWritingEnabled !== false : true);
    const autoImagePromptSettingEnabled =
      (Array.isArray(context?.meta?.hopscotchFused)
        ? context.meta.hopscotchFused.includes('image_prompt')
        : settingsSnapshot.autoImagePromptEnabled === true) &&
      autoImagePromptWritingAllowed &&
      !isMomentCommentTask;
    let autoImagePromptActive = autoImagePromptSettingEnabled;
    let autoImagePromptRules = '';
    let autoImagePromptPosition = 0;
    let autoImagePromptDepth = 1;
    let autoImagePromptRole = 0;
    const includeTableEditInFormatReminder = Boolean(context?.meta?.memoryAutoExtract)
      || Boolean(String(memoryGuidePrompt?.content || '').includes('<memory_edit_rules>'));
    const formatReminderSurface = isMomentCommentTask
      ? 'moment_comment'
      : (isGroupChat ? 'group_chat' : 'private_chat');
    const formatReminderPlan = resolveBuiltinPhoneFormatReminderPlan({
      hasPreset: openAIFormatReminderState.hasPreset,
      isDefaultPreset: isDefaultOpenAIPreset,
      contractDisabled: explicitlyDisablePhoneFormat,
      responseTarget: replyTarget,
      assistantContinuation: context?.meta?.assistantContinuation?.enabled === true,
      suppressPendingUserTurn,
      scenarioReminder: scenarioFormatReminder,
      surface: formatReminderSurface,
      userName: name1,
      targetName: formatPrivateTargetName,
      groupName: formatGroupName,
      includeTableEdit: includeTableEditInFormatReminder,
    });
    const pendingUserHints = [replyPromptHint].filter(Boolean);
    const pendingUserHint = pendingUserHints.join('；');
    const appendScenarioFormatReminderToUserInput = Boolean(formatReminderPlan.userScenarioText);
    const pendingUserText = buildPendingUserTextWithScenarioReminder({
      rawText: pendingUserTextRaw,
      replyHint: pendingUserHint,
      scenarioReminder: formatReminderPlan.userScenarioText,
      suppressPendingUserTurn,
      appendScenarioReminder: appendScenarioFormatReminderToUserInput,
    });
    const requestConfig = options?.requestConfig && typeof options.requestConfig === 'object'
      ? options.requestConfig
      : (this.config?.get?.() || {});
    const provider = String(requestConfig?.provider || '').trim().toLowerCase();
    const requestModel = String(requestConfig?.model || '').trim().toLowerCase();
    const providerNeedsExplicitUserTurn = shouldUseDeepSeekReasonerCompatibility({
      provider,
      model: requestModel,
      baseUrl: requestConfig?.baseUrl,
    });
	    const providerUsesDetachedSystemPrompt =
	      provider === 'anthropic' ||
	      provider === 'gemini' ||
	      provider === 'makersuite' ||
	      provider === 'vertexai';
	    const providerRejectsAssistantPrefill = provider === 'anthropic';
	    const lastUserMessageRe = /{{\s*(?:lastUserMessage|userLastMessage|user_last_message)\s*}}/i;
	    const hasLastUserMessagePlaceholder = (raw) => lastUserMessageRe.test(String(raw || ''));
	    let usedLastUserMessageForPendingInput = false;
	    let syntheticAssistantDowngradeCount = 0;
      let timeContextAfterHistoryInserted = false;
      const insertTimeContextAfterHistory = () => {
        if (timeContextAfterHistoryInserted || !timeContextBlock) return;
        messages.push(timeContextBlock);
        timeContextAfterHistoryInserted = true;
      };
	    const normalizeRequestRole = (role) => {
	      const normalizedRole = String(role || '').trim().toLowerCase();
	      return normalizedRole === 'user' || normalizedRole === 'assistant' || normalizedRole === 'system'
	        ? normalizedRole
	        : 'system';
	    };
	    const normalizeSyntheticRoleForCheck = (role) => {
	      const normalizedRole = normalizeRequestRole(role);
	      if (providerRejectsAssistantPrefill && normalizedRole === 'assistant') return 'system';
	      return normalizedRole;
	    };
	    const normalizeSyntheticRole = (role, { count = true } = {}) => {
	      const normalizedRole = normalizeRequestRole(role);
	      if (providerRejectsAssistantPrefill && normalizedRole === 'assistant') {
	        if (count) syntheticAssistantDowngradeCount += 1;
	        return 'system';
	      }
	      return normalizedRole;
	    };
	    const buildSyntheticMessage = (role, content) => ({
	      role: normalizeSyntheticRole(role),
	      content,
	    });
    const createSyntheticPromptInjector = (prompt) => {
      const inserted = new Set();
      return {
        insertAt(pos) {
          if (!prompt || !prompt.positions.includes(pos) || inserted.has(pos)) return;
          messages.push(buildSyntheticMessage(prompt.role, prompt.content));
          inserted.add(pos);
        },
        insertIntoHistory(history, options = {}) {
          if (!prompt || !prompt.positions.includes('history_depth') || inserted.has('history_depth')) return;
          const rawDepth = Math.max(0, Math.trunc(Number(prompt?.depth || 0)));
          if (rawDepth === 0) return;
          const depth = options?.hasPendingLatest ? Math.max(0, rawDepth - 1) : rawDepth;
          const idx = Math.max(0, history.length - depth);
          history.splice(idx, 0, buildSyntheticMessage(prompt.role, prompt.content));
          inserted.add('history_depth');
        },
        popDepthZero() {
          if (!prompt || !prompt.positions.includes('history_depth') || inserted.has('history_depth')) return null;
          const depth = Math.max(0, Math.trunc(Number(prompt?.depth || 0)));
          if (depth !== 0) return null;
          inserted.add('history_depth');
          return { role: prompt.role, content: prompt.content };
        },
        popLatestUserPosition(pos) {
          const anchor = String(pos || '').trim().toLowerCase();
          if (
            anchor !== PROMPT_SEGMENT_ANCHORS.BEFORE_LATEST_USER &&
            anchor !== PROMPT_SEGMENT_ANCHORS.AFTER_LATEST_USER
          ) return null;
          if (!prompt || !prompt.positions.includes(anchor) || inserted.has(anchor)) return null;
          inserted.add(anchor);
          return { role: prompt.role, content: prompt.content };
        },
        insertHistoryBoundary(pos) {
          if (!prompt || !prompt.positions.includes(pos) || inserted.has(pos)) return;
          messages.push(buildSyntheticMessage(prompt.role, prompt.content));
          inserted.add(pos);
        },
      };
    };
    const memoryGuideInjector = createSyntheticPromptInjector(memoryGuidePrompt);
    const memoryDataInjector = createSyntheticPromptInjector(memoryPrompt);
    const insertMemoryPromptAt = (pos) => {
      memoryGuideInjector.insertAt(pos);
      memoryDataInjector.insertAt(pos);
    };
    const insertMemoryPromptIntoHistory = (history, options = {}) => {
      memoryGuideInjector.insertIntoHistory(history, options);
      memoryDataInjector.insertIntoHistory(history, options);
    };
    const insertMemoryPromptBeforeHistory = () => {
      memoryGuideInjector.insertHistoryBoundary('history_before');
      memoryDataInjector.insertHistoryBoundary('history_before');
    };
    const insertMemoryPromptAfterHistory = () => {
      memoryGuideInjector.insertHistoryBoundary('history_after');
      memoryDataInjector.insertHistoryBoundary('history_after');
    };
	    const normalizeSyntheticMessageList = (list) => {
	      const arr = Array.isArray(list) ? list : [];
	      return arr.map((msg) => {
	        if (!msg || typeof msg !== 'object') return msg;
	        return {
	          ...msg,
	          role: normalizeSyntheticRole(msg.role || 'system'),
	        };
	      });
	    };
	    const canPlaceholderConsumePendingUser = (role, { synthetic = false } = {}) => {
	      const normalizedRole = synthetic ? normalizeSyntheticRoleForCheck(role) : normalizeRequestRole(role);
	      if (providerNeedsExplicitUserTurn) return normalizedRole === 'user';
	      return normalizedRole !== 'system' || !providerUsesDetachedSystemPrompt;
	    };
    const pendingUserPrompt = (() => {
      if (!pendingUserTextRaw && !String(pendingUserText || '').trim()) return '';
      const shouldBypassHint = disableScenarioHint && !replyPromptHint;
      const baseText = shouldBypassHint ? String(rawUserMessage ?? '') : pendingUserText;
      if (context?.meta?.skipInputRegex === true) return String(baseText ?? '');
      return this.regex.apply(baseText, this.getRegexContext(), regex_placement.USER_INPUT, {
        isMarkdown: true,
        isPrompt: true,
        isEdit: false,
        depth: 0,
      });
    })();
    const normalizeAttachmentParts = (parts) => {
      const list = Array.isArray(parts) ? parts : [];
      return list
        .map((part) => {
          if (!part || typeof part !== 'object') return null;
          if (part.type === 'text') {
            const text = String(part.text || '');
            return text ? { type: 'text', text } : null;
          }
          if (part.type === 'image_url') {
            const url = String(part.image_url?.url || '').trim();
            return url ? { type: 'image_url', image_url: { url } } : null;
          }
          return null;
        })
        .filter(Boolean);
    };
    const userAttachmentParts = normalizeAttachmentParts(context?.meta?.userAttachmentParts);
    const hasUserAttachments = userAttachmentParts.length > 0;
    const buildUserContentWithAttachments = (text) => {
      if (!hasUserAttachments) return text;
      const parts = [];
      const base = String(text ?? '');
      if (base.trim()) parts.push({ type: 'text', text: base });
      userAttachmentParts.forEach(part => parts.push(part));
      return parts;
    };
    const pendingUserContent = buildUserContentWithAttachments(pendingUserPrompt);
    const attachmentOnlyContent = hasUserAttachments ? buildUserContentWithAttachments('') : '';
    let attachmentsInserted = false;
    const effectiveLastUserMessage = overrideLastUserMessageRaw.trim()
      ? overrideLastUserMessageRaw.trim()
      : pendingUserPrompt;
    const macroUiMode = String(context?.meta?.uiMode || context?.uiMode || '').trim().toLowerCase() === 'rp' ? 'rp' : 'chat';
    const macroUseGlobalVariables = context?.meta?.useGlobalVariables === true || context?.useGlobalVariables === true;
    const processTextMacrosWithPendingFlag = (rawText, extraContext) => {
      const raw = String(rawText ?? '');
      return raw
        ? this.processTextMacros(raw, {
            ...(extraContext || {}),
            uiMode: macroUiMode,
            lastUserMessage: effectiveLastUserMessage,
            useGlobalVariables: macroUseGlobalVariables,
            macroVariableState: context?.meta?.macroVariableState,
          })
        : '';
    };
    const trimEdgeBlankLines = (text) =>
      String(text ?? '').replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:\r?\n[ \t]*)+$/, '');
	    const joinPromptBlocks = (blocks = []) => {
	      const parts = Array.isArray(blocks) ? blocks : [blocks];
	      const cleaned = parts.map(trimEdgeBlankLines).filter(s => String(s || '').trim().length > 0);
	      return cleaned.join('\n\n');
	    };
	    const contextExtraPromptBlocks = Array.isArray(context?.meta?.extraPromptBlocks)
      ? context.meta.extraPromptBlocks.filter((block) => {
	          if (variableRuntimeEnabled || !block || typeof block !== 'object') return true;
	          const source = String(block.source || block.promptSource || '').trim().toLowerCase();
	          return source !== 'variable_rule' && source !== 'stage';
	        })
	      : [];
	    const globalSemanticPromptBlocks = buildGlobalSemanticPromptExtraBlocks(
	      globalSemanticPromptPlan,
	    );
	    const rawExtraPromptBlocks = [
	      ...globalSemanticPromptBlocks,
	      ...contextExtraPromptBlocks,
	    ];
	    const normalizeExtraPromptPosition = (value) => {
	      const token = String(value || '').trim().toLowerCase();
	      if (!token) return '';
	      if (token === '-1' || token === 'none') return 'none';
	      if (token === '1' || token === 'in_chat' || token === 'depth' || token === 'at_depth') return 'history_depth';
	      if (token === '2' || token === 'before_prompt') return 'before_chat';
	      if (token === '4' || token === 'latest_before') return PROMPT_SEGMENT_ANCHORS.BEFORE_LATEST_USER;
	      if (token === '5' || token === 'latest_after') return PROMPT_SEGMENT_ANCHORS.AFTER_LATEST_USER;
	      if (token === 'before_history') return 'history_before';
	      if (token === 'after_history') return 'history_after';
	      if (token === GLOBAL_SEMANTIC_PROMPT_ANCHORS.semanticHeader) return token;
	      if (
	        token === 'after_persona' ||
	        token === 'system_end' ||
	        token === 'before_chat' ||
	        token === 'history_before' ||
	        token === 'history_after' ||
	        token === 'history_depth' ||
	        token === PROMPT_SEGMENT_ANCHORS.BEFORE_LATEST_USER ||
	        token === PROMPT_SEGMENT_ANCHORS.AFTER_LATEST_USER
	      ) return token;
	      return '';
	    };
	    const parseExtraPromptPositions = (rawPosition) => {
	      const raw = String(rawPosition || '').trim();
	      if (!raw) return [PROMPT_SEGMENT_ANCHORS.BEFORE_LATEST_USER];
	      const out = [];
	      raw.split(/[+,]/).forEach((part) => {
	        const pos = normalizeExtraPromptPosition(part);
	        if (!pos || pos === 'none') return;
	        if (!out.includes(pos)) out.push(pos);
	      });
	      return out.length ? out : [PROMPT_SEGMENT_ANCHORS.BEFORE_LATEST_USER];
	    };
	    const normalizeExtraPromptRole = (roleRaw) => {
	      const role = String(roleRaw || 'system').trim().toLowerCase();
	      return role === 'user' || role === 'assistant' || role === 'system' ? role : 'system';
	    };
	    const normalizeExtraPromptOrder = (block, fallback) => {
	      const raw = Number(block?.promptOrder ?? block?.order);
	      return Number.isFinite(raw) ? raw : fallback;
	    };
	    const normalizeExtraPromptDepth = (block) => {
	      const raw = Math.trunc(Number(block?.depth ?? block?.promptDepth));
	      return Number.isFinite(raw) ? Math.max(0, raw) : 0;
	    };
	    const inferExtraPromptDefaultOrder = (block, index) => {
	      const source = String(block?.source || block?.promptSource || '').trim().toLowerCase();
	      if (source === 'stage') return 3200 + index;
	      if (source === 'variable_rule' || source === 'prompt_injection') return 3500 + index;
	      return 3000 + index;
	    };
	    const buildExtraPromptPlan = () => {
	      const extraGroupName = String(context?.group?.name || '').trim() || name2;
	      const extraMembersText = Array.isArray(context?.group?.memberNames)
	        ? context.group.memberNames.map(String).filter(Boolean).join(',')
	        : '';
	      const plan = {
	        semantic_header: [],
	        after_persona: [],
	        system_end: [],
	        before_chat: [],
	        history_before: [],
	        history_after: [],
	        depthMessages: [],
	        consumesLastUser: false,
	      };
	      rawExtraPromptBlocks.forEach((rawBlock, idx) => {
	        const block = rawBlock && typeof rawBlock === 'object'
	          ? rawBlock
	          : { content: String(rawBlock || '') };
	        const rawContent = String(block?.content ?? block?.prompt ?? '').trim();
	        if (!rawContent) return;
	        const role = normalizeExtraPromptRole(block?.role);
	        if (
	          block?.preRendered !== true &&
	          !plan.consumesLastUser &&
	          hasLastUserMessagePlaceholder(rawContent) &&
	          canPlaceholderConsumePendingUser(role, { synthetic: true })
	        ) {
	          plan.consumesLastUser = true;
	        }
	        const rendered = block?.preRendered === true ? rawContent : processTextMacrosWithPendingFlag(rawContent, {
	          user: name1,
	          char: name2,
	          group: extraGroupName,
	          members: extraMembersText,
	        });
	        const content = trimEdgeBlankLines(rendered);
	        if (!content) return;
	        const fallbackOrder = inferExtraPromptDefaultOrder(block, idx);
	        const promptOrder = normalizeExtraPromptOrder(block, fallbackOrder);
	        const promptSeq = Number.isFinite(Number(block?.promptSeq ?? block?.seq))
	          ? Number(block?.promptSeq ?? block?.seq)
	          : idx;
	        const source = String(block?.source || block?.promptSource || 'extra_prompt').trim() || 'extra_prompt';
	        const depth = normalizeExtraPromptDepth(block);
	        const anchorRaw = block?.promptAnchor || block?.anchor || block?.latestUserAnchor || '';
	        const anchor = normalizePromptSegmentAnchor(anchorRaw, PROMPT_SEGMENT_ANCHORS.BEFORE_LATEST_USER);
	        parseExtraPromptPositions(block?.position ?? block?.promptPosition).forEach((pos) => {
	          const msg = {
	            role,
	            content,
	            depth,
	            promptOrder,
	            promptSeq,
	            promptSource: source,
	          };
	          if (pos === PROMPT_SEGMENT_ANCHORS.BEFORE_LATEST_USER || pos === PROMPT_SEGMENT_ANCHORS.AFTER_LATEST_USER) {
	            plan.depthMessages.push({
	              ...msg,
	              depth: 0,
	              promptAnchor: pos,
	            });
	            return;
	          }
	          if (pos === 'history_depth') {
	            plan.depthMessages.push({
	              ...msg,
	              promptAnchor: depth === 0 ? anchor : undefined,
	            });
	            return;
	          }
	          if (Array.isArray(plan[pos])) {
	            plan[pos].push(msg);
	          }
	        });
	      });
	      ['semantic_header', 'after_persona', 'system_end', 'before_chat', 'history_before', 'history_after'].forEach((slot) => {
	        plan[slot] = plan[slot].sort((a, b) => {
	          const ao = Number.isFinite(Number(a?.promptOrder)) ? Number(a.promptOrder) : 0;
	          const bo = Number.isFinite(Number(b?.promptOrder)) ? Number(b.promptOrder) : 0;
	          if (ao !== bo) return ao - bo;
	          return (Number(a?.promptSeq) || 0) - (Number(b?.promptSeq) || 0);
	        });
	      });
	      return plan;
	    };
	    const extraPromptPlan = buildExtraPromptPlan();
	    const insertExtraPromptAt = (slot) => {
	      const key = String(slot || '').trim();
	      const list = Array.isArray(extraPromptPlan?.[key]) ? extraPromptPlan[key] : [];
	      if (!list.length) return;
	      list.forEach(msg => {
	        if (!msg?.content) return;
	        messages.push(buildSyntheticMessage(msg.role || 'system', msg.content));
	      });
	      list.length = 0;
	    };
	    insertExtraPromptAt(GLOBAL_SEMANTIC_PROMPT_ANCHORS.semanticHeader);
	    // SillyTavern-like persona settings (subset)
	    const personaRaw = String(context?.user?.persona || '');
    const personaPosition = Number.isFinite(Number(context?.user?.personaPosition))
      ? Number(context.user.personaPosition)
      : 0; // IN_PROMPT
    const personaDepth = Number.isFinite(Number(context?.user?.personaDepth))
      ? Math.max(0, Math.trunc(Number(context.user.personaDepth)))
      : 2;
    const personaRole = Number.isFinite(Number(context?.user?.personaRole))
      ? Math.max(0, Math.min(2, Math.trunc(Number(context.user.personaRole))))
      : 0; // 0=system
    const personaText = personaRaw ? processTextMacrosWithPendingFlag(personaRaw, { user: name1, char: name2 }) : '';
    const stringifyMatchContent = (content) => {
      if (Array.isArray(content)) {
        return content
          .map((part) => (part?.type === 'text' ? String(part.text || '') : ''))
          .filter(Boolean)
          .join('\n');
      }
      return String(content ?? '');
    };
    const historyForMatch = Array.isArray(context.history) ? context.history : [];
    const globalWorldSettings = this.getWorldGlobalSettings?.() || this.worldGlobalSettings || {};
    const includeNames = globalWorldSettings.includeNames === true;
    const fullHistoryLines = historyForMatch
      .map(m => {
        const content = stringifyMatchContent(m?.content);
        if (!content) return '';
        if (!includeNames) return content;
        const role = String(m?.role || '').trim();
        const speaker = String(m?.name || (role === 'user' ? name1 : role === 'assistant' ? name2 : '') || '').trim();
        return speaker ? `${speaker}: ${content}` : content;
      })
      .filter(Boolean);
    let historyMatchLines = [...fullHistoryLines];
    const globalScanDepthRaw = globalWorldSettings.scanDepth;
    const globalScanDepth = Number.isFinite(Number(globalScanDepthRaw)) ? Math.max(0, Math.trunc(Number(globalScanDepthRaw))) : null;
    if (globalScanDepth !== null) {
      historyMatchLines = historyMatchLines.slice(-globalScanDepth);
    }
    const momentTaskPromptData = isMomentCommentTask ? String(context?.task?.promptData || '') : '';
    const momentTaskTriggerText = isMomentCommentTask
      ? String(context?.task?.triggerText || momentTaskPromptData || '')
      : '';
    const matchText = (
      isMomentCommentTask
        ? [String(userMessage ?? ''), momentTaskTriggerText, ...historyMatchLines]
        : [String(userMessage ?? ''), ...historyMatchLines]
    ).filter(item => String(item || '').trim()).join('\n');
    const sessionName = String(context?.session?.name || '').trim();
    const matchSessionId = isMomentCommentTask
      ? String(context?.task?.targetSessionId || sessionId).trim()
      : sessionId;
    const matchSessionName = isMomentCommentTask
      ? String(context?.task?.targetName || sessionName).trim()
      : sessionName;
    const matchContext = {
      userMessage: String(userMessage ?? ''),
      history: historyMatchLines,
      fullHistory: fullHistoryLines,
      personaText,
      sessionId: matchSessionId,
      sessionName: matchSessionName,
      uiMode,
      character: {
        description: String(context?.character?.description || ''),
        personality: String(context?.character?.personality || ''),
        scenario: String(context?.character?.scenario || ''),
        depthPrompt: String(context?.character?.depthPrompt || ''),
        creatorNotes: String(context?.character?.creatorNotes || ''),
      },
    };
    const groupName = String(context?.group?.name || '').trim();
    const groupMemberIds = Array.isArray(context?.group?.members) ? context.group.members.map(String) : [];
    const groupMemberNames = Array.isArray(context?.group?.memberNames) ? context.group.memberNames.map(String) : [];
    if (groupMemberNames.length) {
      matchContext.groupMemberNames = groupMemberNames;
    }
    const membersText = groupMemberNames.filter(Boolean).join(',');
    const momentWorldSessionId = String(matchSessionId || sessionId || this.activeSessionId || '').trim();
    const resolvedWorldStateBase = this.getResolvedWorldState(
      isMomentCommentTask ? momentWorldSessionId : (sessionId || this.activeSessionId),
      {
        uiMode: isMomentCommentTask ? 'chat' : uiMode,
        isGroupChat: isMomentCommentTask ? false : isGroupChat,
        groupMemberIds: isMomentCommentTask ? [] : groupMemberIds,
      },
    );
    const resolvedWorldState = isMomentCommentTask
      ? {
          ...resolvedWorldStateBase,
          uiMode: 'moments',
          isGroupChat: false,
          groupMemberIds: [],
          sessionWorldIds: [],
          worldIds: [
            ...(Array.isArray(resolvedWorldStateBase.globalWorldIds) ? resolvedWorldStateBase.globalWorldIds : []),
            ...(Array.isArray(resolvedWorldStateBase.roleWorldIds) ? resolvedWorldStateBase.roleWorldIds : []),
          ].filter(Boolean),
        }
      : resolvedWorldStateBase;
    const macroContext = {
      user: name1,
      char: name2,
      group: groupName || name2,
      members: membersText,
      scenario: context?.character?.scenario || '',
      personality: context?.character?.personality || '',
    };

    const getSessionSummaryItems = (sid, { limitPlain = 30, limitPlainGroup = 10, limitWithCompacted = 2, limitWithCompactedGroup = 3 } = {}) => {
      const id = String(sid || '').trim();
      if (!id || !this.chatStore?.getSummaries) return { compacted: null, summaries: [] };
      const compacted = this.chatStore?.getCompactedSummary?.(id) || null;
      const list = this.chatStore.getSummaries(id) || [];
      const arrRaw = Array.isArray(list) ? list : [];

      if (isGroupChat) {
        if (compacted && String(compacted.text || '').trim()) {
          return { compacted, summaries: arrRaw.slice(-Math.max(0, limitWithCompactedGroup)) };
        }
        return { compacted: null, summaries: arrRaw.slice(-Math.max(0, limitPlainGroup)) };
      }

      // Non-group chats keep existing behavior unless caller wants different limits.
      if (compacted && String(compacted.text || '').trim()) {
        return { compacted, summaries: arrRaw.slice(-Math.max(0, limitWithCompacted)) };
      }
      return { compacted: null, summaries: arrRaw.slice(-Math.max(0, limitPlain)) };
    };

    const buildPrivateChatMemberGroupSummaryBlock = () => {
      if (isGroupChat) return null;
      if (isMomentCommentTask) return null;
      const memberId = String(sessionIdForSummary || '').trim();
      if (!memberId) return null;
      if (!this.chatStore?.getSummaries) return null;
      const groups = (() => {
        try {
          const list = this.contactsStore?.listGroups?.() || [];
          return Array.isArray(list)
            ? list.filter(g => Array.isArray(g?.members) && g.members.map(String).includes(memberId))
            : [];
        } catch {
          return [];
        }
      })();
      if (!groups.length) return null;

      const sections = [];
      for (const g of groups) {
        const gid = String(g?.id || '').trim();
        if (!gid) continue;
        const gname = String(g?.name || '').trim() || gid.replace(/^group:/, '') || gid;

        const compacted = this.chatStore?.getCompactedSummary?.(gid) || null;
        const list = this.chatStore.getSummaries(gid) || [];
        const arrRaw = Array.isArray(list) ? list : [];
        const arr = (compacted && String(compacted.text || '').trim()) ? arrRaw.slice(-2) : arrRaw.slice(-5);
        const items = [];
        if (compacted && String(compacted.text || '').trim()) {
          items.push(formatMemoryPromptText('memory.summary.long_line', '- 大总结：{value}', {
            value: String(compacted.text).trim(),
          }));
        }
        for (let j = 0; j < arr.length; j++) {
          const it = arr[j];
          const text = String((typeof it === 'string') ? it : it?.text || '').trim();
          if (!text) continue;
          const at = (typeof it === 'object' && it && it.at) ? Number(it.at) : 0;
          const isNewest = j === arr.length - 1;
          const when = (isNewest && at) ? formatSinceInParens(at) : '';
          items.push(`- ${text}${when ? formatMemoryPromptText(
            'memory.summary.relative_suffix',
            '（{value}）',
            { value: when },
          ) : ''}`);
        }
        if (items.length) {
          sections.push([formatMemoryPromptText('memory.summary.group_label', '群聊：{value}', { value: gname }), ...items].join('\n'));
        }
      }
      if (!sections.length) return null;
      return {
        role: 'system',
        content: [
          formatMemoryPromptText(
            'memory.summary.character_groups_header',
            '角色所在群聊摘要回顾（仅供理解上下文）：',
          ),
          ...sections,
        ].join('\n\n'),
      };
    };
    // 对话模式：额外注入对话协议提示词（保存于 sysprompt 预设）
    // ST extension prompt types => IN_PROMPT:0, IN_CHAT:1, BEFORE_PROMPT:2, NONE:-1
    const dialogueEnabled = Boolean(sysp?.dialogue_enabled);
    const dialogueRulesRaw = typeof sysp?.dialogue_rules === 'string' ? sysp.dialogue_rules : '';
    const dialogueRules = dialogueEnabled ? processTextMacrosWithPendingFlag(dialogueRulesRaw, { user: name1, char: name2 }) : '';
    const dialoguePosition = Number.isFinite(Number(sysp?.dialogue_position))
      ? Number(sysp.dialogue_position)
      : 0;
    const dialogueDepth = Number.isFinite(Number(sysp?.dialogue_depth))
      ? Math.max(0, Math.trunc(Number(sysp.dialogue_depth)))
      : 1;
    const dialogueRole = Number.isFinite(Number(sysp?.dialogue_role))
      ? Math.trunc(Number(sysp.dialogue_role))
      : 0;

    // 动态发布决策提示词（用于私聊/群聊场景）
    const momentCreateEnabled = Boolean(sysp?.moment_create_enabled);
    const momentCreateRulesRaw =
      typeof sysp?.moment_create_rules === 'string' ? sysp.moment_create_rules : '';
    const momentCreateRules = momentCreateEnabled
      ? processTextMacrosWithPendingFlag(momentCreateRulesRaw, { user: name1, char: name2 })
      : '';
    const momentCreatePosition = Number.isFinite(Number(sysp?.moment_create_position))
      ? Number(sysp.moment_create_position)
      : 0;
    const momentCreateDepth = Number.isFinite(Number(sysp?.moment_create_depth))
      ? Math.max(0, Math.trunc(Number(sysp.moment_create_depth)))
      : 1;
    const momentCreateRole = Number.isFinite(Number(sysp?.moment_create_role))
      ? Math.trunc(Number(sysp.moment_create_role))
      : 0;
    const shouldEmbedMomentCreateInPhoneFormat =
      !disablePhoneFormat &&
      syspActive?.phone_format_moment_enabled !== false;

    // 动态评论回复提示词（仅用于用户评论/楼中楼回复任务）
    const momentCommentEnabled = Boolean(sysp?.moment_comment_enabled);
    const momentCommentRulesRaw =
      typeof sysp?.moment_comment_rules === 'string' ? sysp.moment_comment_rules : '';
    const momentCommentRules = momentCommentEnabled
      ? processTextMacrosWithPendingFlag(momentCommentRulesRaw, { user: name1, char: name2 })
      : '';
    const momentCommentPosition = Number.isFinite(Number(sysp?.moment_comment_position))
      ? Number(sysp.moment_comment_position)
      : 0;
    const momentCommentDepth = Number.isFinite(Number(sysp?.moment_comment_depth))
      ? Math.max(0, Math.trunc(Number(sysp.moment_comment_depth)))
      : 0;
    const momentCommentRole = Number.isFinite(Number(sysp?.moment_comment_role))
      ? Math.trunc(Number(sysp.moment_comment_role))
      : 0;

    // 发布后评论提示词（仅用于用户发布动态后的自动评论任务）
    const momentPublishCommentEnabled = Boolean(sysp?.moment_publish_comment_enabled);
    const momentPublishCommentRulesRaw =
      typeof sysp?.moment_publish_comment_rules === 'string' ? sysp.moment_publish_comment_rules : '';
    const momentPublishCommentRules = momentPublishCommentEnabled
      ? processTextMacrosWithPendingFlag(momentPublishCommentRulesRaw, { user: name1, char: name2 })
      : '';
    const momentPublishCommentPosition = Number.isFinite(Number(sysp?.moment_publish_comment_position))
      ? Number(sysp.moment_publish_comment_position)
      : 0;
    const momentPublishCommentDepth = Number.isFinite(Number(sysp?.moment_publish_comment_depth))
      ? Math.max(0, Math.trunc(Number(sysp.moment_publish_comment_depth)))
      : 0;
    const momentPublishCommentRole = Number.isFinite(Number(sysp?.moment_publish_comment_role))
      ? Math.trunc(Number(sysp.moment_publish_comment_role))
      : 0;

    // 群聊模式：群聊协议提示词（保存于 sysprompt 预设）
    const groupEnabled = Boolean(sysp?.group_enabled);
    const groupRulesRaw = typeof sysp?.group_rules === 'string' ? sysp.group_rules : '';
    const groupRules = groupEnabled ? processTextMacrosWithPendingFlag(groupRulesRaw, {
      user: name1,
      char: name2,
      group: groupName || name2,
      members: membersText,
    }) : '';
    const groupPosition = Number.isFinite(Number(sysp?.group_position)) ? Number(sysp.group_position) : 0;
    const groupDepth = Number.isFinite(Number(sysp?.group_depth))
      ? Math.max(0, Math.trunc(Number(sysp.group_depth)))
      : 1;
    const groupRole = Number.isFinite(Number(sysp?.group_role)) ? Math.trunc(Number(sysp.group_role)) : 0;

    // 自动标签生图提示词：总开关在通用设定，具体文案和注入位置放在“聊天提示词”预设中管理。
    const autoImagePromptPresetEnabled = useSysprompt && sysp?.auto_image_prompt_enabled !== false;
    const autoImagePromptRulesRaw = typeof sysp?.auto_image_prompt_rules === 'string' ? sysp.auto_image_prompt_rules : '';
    // 请求预览不受频率闸门影响：预览应稳定展示启用中的生图提示词
    const autoImagePromptInjectGuard = (autoImagePromptSettingEnabled && !context?.meta?.previewOnly)
      ? shouldAllowAutoImagePromptByRateLimit({
        messages: this.chatStore?.getMessages?.(sessionId) || [],
        settings: settingsSnapshot,
        nextAssistantTurn: true,
        checkRepeated: false,
      })
      : { ok: true, reason: '' };
    if (autoImagePromptSettingEnabled && !autoImagePromptInjectGuard.ok) {
      logger.debug?.(`auto image prompt injection skipped: ${autoImagePromptInjectGuard.reason}`);
    }
    autoImagePromptRules = (autoImagePromptSettingEnabled && autoImagePromptPresetEnabled && autoImagePromptInjectGuard.ok
      && !context?.meta?.previewSuppressAutoImagePrompt)
      ? buildAutoImagePromptInstruction({
        uiMode,
        isGroupChat,
        modelHint: context?.meta?.autoImagePromptModelHint,
        style: settingsSnapshot.autoImagePromptStyle,
        decisionMode: settingsSnapshot.autoImagePromptDecisionMode,
        template: processTextMacrosWithPendingFlag(autoImagePromptRulesRaw, {
          user: name1,
          char: name2,
          group: groupName || name2,
          members: membersText,
        }),
      })
      : '';
    autoImagePromptActive = Boolean(autoImagePromptRules);
    autoImagePromptPosition = Number.isFinite(Number(sysp?.auto_image_prompt_position))
      ? Number(sysp.auto_image_prompt_position)
      : 1;
    autoImagePromptDepth = Number.isFinite(Number(sysp?.auto_image_prompt_depth))
      ? Math.max(0, Math.trunc(Number(sysp.auto_image_prompt_depth)))
      : 0;
    autoImagePromptRole = Number.isFinite(Number(sysp?.auto_image_prompt_role))
      ? Math.trunc(Number(sysp.auto_image_prompt_role))
      : 0;

    // Formatting helpers from OpenAI preset (optional)
    const wiFormatRaw =
      typeof openp?.wi_format === 'string' && openp.wi_format.includes('{0}') ? openp.wi_format : '{0}';
	    const wiFormat =
	      processTextMacrosWithPendingFlag(wiFormatRaw, {
	        user: name1,
	        char: name2,
	        group: groupName || name2,
	        members: membersText,
	      }) || '{0}';
    const scenarioFormat = typeof openp?.scenario_format === 'string' ? openp.scenario_format : '{{scenario}}';
    const personalityFormat =
      typeof openp?.personality_format === 'string' ? openp.personality_format : '{{personality}}';
    const impersonationPromptRaw = replyTarget === 'user'
      ? (typeof activeOpenAIPreset?.impersonation_prompt === 'string' && activeOpenAIPreset.impersonation_prompt.trim()
        ? activeOpenAIPreset.impersonation_prompt
        : DEFAULT_OPENAI_IMPERSONATION_PROMPT)
      : '';
    const impersonationPrompt = impersonationPromptRaw
      ? processTextMacrosWithPendingFlag(impersonationPromptRaw, {
          user: name1,
          char: name2,
          group: groupName || name2,
          members: membersText,
        })
      : '';

	    // When OpenAI preset has prompt_order: use ST-like block ordering (drag & drop in UI)
	    // ST PromptManager global dummyId=100001; keep 100000 as fallback.
	    const pickOpenAIOrderBlock = () => {
	      const arr = Array.isArray(openp?.prompt_order) ? openp.prompt_order : [];
	      const byId = (id) => arr.find(b => b && typeof b === 'object' && String(b.character_id) === String(id));
	      return byId(100001) || byId(100000) || arr[0] || null;
	    };
	    const openaiOrderBlock = pickOpenAIOrderBlock();
	    const openaiOrder = Array.isArray(openaiOrderBlock?.order) ? openaiOrderBlock.order : null;

	    // 摘要提示词：移入“聊天提示词”区块管理，并固定在 ST IN_CHAT / SYSTEM / D1。
	    const summaryPosition = (() => {
	      if (!useSysprompt) return 1;
	      if (!syspActive || typeof syspActive !== 'object') return 1;
	      const n = Number(syspActive.summary_position);
	      return Number.isFinite(n) ? n : 1;
	    })();
	    const summaryEnabled = (() => {
	      if (!useSummaryMemory) return false;
	      if (summaryPosition === -1) return false;
	      if (!useSysprompt) return true;
	      if (!syspActive || typeof syspActive !== 'object') return true;
	      return syspActive.summary_enabled !== false;
	    })();
	    const summaryRulesRaw = (() => {
	      const fallback = getLocalizedPromptText('summary_rules', SUMMARY_REQUEST_NOTICE);
	      if (!useSysprompt) return fallback;
	      if (!syspActive || typeof syspActive !== 'object') return fallback;
	      const raw = typeof syspActive.summary_rules === 'string' ? syspActive.summary_rules : '';
	      return raw.trim() ? raw : fallback;
	    })();
	    const summaryRules = summaryEnabled
	      ? processTextMacrosWithPendingFlag(summaryRulesRaw, {
	          user: name1,
	          char: name2,
	          group: groupName || name2,
	          members: membersText,
	        })
	      : '';

	    // 聊天提示词（私聊/群聊/动态/摘要）：按 ST 扩展位置注入。
	    // - IN_PROMPT / BEFORE_PROMPT：相对 main prompt 注入
	    // - IN_CHAT：按 depth/role 注入历史
	    const buildChatGuideBlock = (parts) => {
	      const content = joinPromptBlocks(parts);
	      if (!content) return '';
	      return `<chat_guide>\n${content}\n</chat_guide>`;
	    };
	    const buildChatGuideHistoryMessages = (items) => {
	      const roleMap = { 0: 'system', 1: 'user', 2: 'assistant' };
	      const out = [];
	      const list = Array.isArray(items) ? items : [];
	      list.forEach((item, idx) => {
	        const content = trimEdgeBlankLines(item?.content || '');
	        if (!content) return;
	        const role = roleMap[item?.role] || 'system';
	        let finalContent = content;
	        if (role !== 'system') {
	          const normalized = normalizeHistoryLineBreaks(content, role, { preserveParagraphs: preserveCreativeHistoryParagraphs });
	          const speaker = role === 'assistant' ? name2 : name1;
	          finalContent = withSpeakerPrefix(normalized, speaker);
	        }
	        out.push({
	          role,
	          content: finalContent,
	          depth: Number(item?.depth) || 0,
	          _seq: Number.isFinite(Number(item?._seq)) ? item._seq : idx,
            promptAnchor: item?.promptAnchor || PROMPT_SEGMENT_ANCHORS.BEFORE_LATEST_USER,
            promptOrder: Number.isFinite(Number(item?.promptOrder)) ? Number(item.promptOrder) : 1000 + idx,
            promptSource: String(item?.promptSource || 'chat_guide'),
	        });
	      });
  return out;
};

const stringifyMessageContent = (content) => {
  if (Array.isArray(content)) {
    return content
      .map(part => (part?.type === 'text' ? String(part.text || '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  return String(content ?? '');
};
    const finalizeProviderMessages = () => {
      return this.normalizeOutgoingProviderMessages(messages, requestConfig, {
        syntheticAssistantDowngradeCount,
      });
    };
    const appendOutputFormatReminder = () => {
      const activeSyspromptPresetId = String(syspResolved?.presetId || '').trim();
      const activeSyspromptPresetName = String(syspActive?.name || '').trim();
      const isDeepSeek = isDeepSeekApiRequest({
        provider,
        model: requestModel,
        baseUrl: requestConfig?.baseUrl,
      });
      const isChatMode = uiMode !== 'rp';
      this.lastDeepSeekFormatDebug = {
        provider,
        model: requestModel,
        baseUrl: String(requestConfig?.baseUrl || '').trim(),
        uiMode,
        isChatMode,
        isDeepSeekApiRequest: isDeepSeek,
        universalFormatReminder: true,
        openaiPresetId: activeOpenAIPresetId,
        openaiPresetName: activeOpenAIPresetName,
        openaiPresetSource: String(openaiResolved?.source || '').trim(),
        isDefaultOpenAIPreset,
        syspromptPresetId: activeSyspromptPresetId,
        syspromptPresetName: activeSyspromptPresetName,
        syspromptPresetSource: String(syspResolved?.source || '').trim(),
        dsFormatEnabledFlag: true,
        dsFormatRulesPresent: true,
        dsFormatEnabled: isDefaultOpenAIPreset && !explicitlyDisablePhoneFormat && replyTarget !== 'user',
        dsFormatInjected: formatReminderPlan.usesBuiltinContract,
        dsFormatInjectedRole: formatReminderPlan.deliveryRole,
        contractSurface: formatReminderSurface,
        responseTarget: replyTarget,
        scenarioReminderAppendedToUserInput: appendScenarioFormatReminderToUserInput,
        transportLayerDeferred: deferPhoneTransportLayers,
        dsFormatTextPreview: String(
          formatReminderPlan.systemText || formatReminderPlan.userScenarioText || '',
        ).replace(/\s+/g, ' ').trim().slice(0, 160),
      };
      if (formatReminderPlan.systemText) {
        if (deferPhoneTransportLayers) {
          const marker = createTransportAnchorMarker('output_format');
          deferredLegacyLayers.push({
            id: 'output_format',
            content: formatReminderPlan.systemText,
            marker,
          });
          messages.push({ role: 'system', content: marker });
        } else {
          messages.push({ role: 'system', content: formatReminderPlan.systemText });
        }
      }
    };
	    const buildChatGuidePlan = () => {
	      const mode = String(context?.meta?.chatGuideMode || '').trim().toLowerCase();
	      if (Boolean(context?.meta?.disableChatGuide) || mode === 'none') {
	        return { promptContent: '', beforePromptContent: '', depthContent: '', depthMessages: [] };
	      }
	      const summaryOnly = mode === 'summary-only';
	      const promptParts = [];
	      const beforePromptParts = [];
	      const depthParts = [];
	      const historyItems = [];
	      let seq = 0;
	      const getHistoryPromptOrder = (source, fallback) => (
	        source === 'auto_image_prompt'
	          ? 3000 + fallback
	          : 1000 + fallback
	      );
	      const pushByPosition = (content, position, depth, role, source = 'chat_guide') => {
	        const pos = Number.isFinite(Number(position)) ? Math.trunc(Number(position)) : 0;
	        const trimmed = trimEdgeBlankLines(content);
	        if (!trimmed || pos === -1) return;
	        if (pos === 1) {
	          historyItems.push({
              content: trimmed,
              depth: Number(depth) || 0,
              role: Number(role) || 0,
              _seq: seq,
              promptAnchor: PROMPT_SEGMENT_ANCHORS.BEFORE_LATEST_USER,
              promptOrder: getHistoryPromptOrder(source, seq),
              promptSource: source,
            });
            seq += 1;
	          return;
	        }
	        if (pos === 4 || pos === 5) {
	          historyItems.push({
              content: trimmed,
              depth: 0,
              role: Number(role) || 0,
              _seq: seq,
              promptAnchor: pos === 4
                ? PROMPT_SEGMENT_ANCHORS.BEFORE_LATEST_USER
                : PROMPT_SEGMENT_ANCHORS.AFTER_LATEST_USER,
              promptOrder: getHistoryPromptOrder(source, seq),
              promptSource: source,
            });
            seq += 1;
	          return;
	        }
	        if (pos === 2) {
	          beforePromptParts.push(trimmed);
	          return;
	        }
		        if (pos === 3) {
		          historyItems.push({
	              content: trimmed,
	              depth: 1,
	              role: 0,
	              _seq: seq,
	              promptAnchor: PROMPT_SEGMENT_ANCHORS.BEFORE_LATEST_USER,
	              promptOrder: getHistoryPromptOrder(source, seq),
	              promptSource: source,
	            });
	            seq += 1;
		          return;
		        }
	        promptParts.push(trimmed);
	      };
	      const groupSystemHint = '系统消息：内容';
	      // 请求预览可按注入选择条抑制聊天格式/动态发布（仅 previewOnly 链路设置这些 meta）
	      const suppressChatFormatGuide = Boolean(context?.meta?.previewSuppressChatFormatGuide);
	      const suppressMomentCreate = Boolean(context?.meta?.previewSuppressMomentCreate);
	      if (!summaryOnly && !isMomentCommentTask && !isGroupChat && dialogueEnabled && dialogueRules && !suppressChatFormatGuide) {
	        pushByPosition(dialogueRules, dialoguePosition, dialogueDepth, dialogueRole, 'chat_guide');
	      }
	      if (!summaryOnly && !isMomentCommentTask && isGroupChat && groupEnabled && groupRules && !suppressChatFormatGuide) {
	        const combined = joinPromptBlocks([groupRules, groupSystemHint]);
	        pushByPosition(combined, groupPosition, groupDepth, groupRole, 'chat_guide');
	      }
	      if (!summaryOnly && !isMomentCommentTask && momentCreateEnabled && momentCreateRules && !shouldEmbedMomentCreateInPhoneFormat && !suppressMomentCreate) {
	        pushByPosition(momentCreateRules, momentCreatePosition, momentCreateDepth, momentCreateRole, 'moment_create');
	      }
	      if (!summaryOnly && isMomentCommentTask) {
	        if (isPublishedMomentCommentTask && momentPublishCommentEnabled && momentPublishCommentRules) {
	          pushByPosition(
	            momentPublishCommentRules,
	            momentPublishCommentPosition,
	            momentPublishCommentDepth,
	            momentPublishCommentRole,
              'moment_publish_comment',
	          );
	        } else if (!isPublishedMomentCommentTask && momentCommentEnabled && momentCommentRules) {
	          pushByPosition(momentCommentRules, momentCommentPosition, momentCommentDepth, momentCommentRole, 'moment_comment');
	        }
	      }
	      if ((!summaryOnly || uiMode === 'rp') && autoImagePromptRules) {
	        pushByPosition(autoImagePromptRules, autoImagePromptPosition, autoImagePromptDepth, autoImagePromptRole, 'auto_image_prompt');
	      }
	      if (summaryRules) {
	        pushByPosition(summaryRules, summaryPosition, 1, 0, 'summary');
	      }
	      return {
	        promptContent: buildChatGuideBlock(promptParts),
	        beforePromptContent: buildChatGuideBlock(beforePromptParts),
	        depthContent: buildChatGuideBlock(depthParts),
	        depthMessages: buildChatGuideHistoryMessages(historyItems),
	      };
	    };

	    const buildMomentCommentDataBlock = () => {
	      if (!isMomentCommentTask) return null;
	      const raw = String(context?.task?.promptData || '').trim();
	      if (!raw) return null;
	      const content = processTextMacrosWithPendingFlag(raw, {
	        user: name1,
	        char: name2,
	        group: groupName || name2,
	        members: membersText,
	      });
	      const rendered = String(content || '').trim();
	      if (!rendered) return null;
	      if (this.lastPhoneFormatTransportPlan) {
	        this.lastPhoneFormatTransportPlan.momentCommentDataContent = rendered;
	      }
	      return { role: 'system', content: rendered };
	    };

	    const buildMomentSummaryBlock = () => {
	      if (Boolean(context?.meta?.disableMomentSummary)) return null;
	      if (!this.momentSummaryStore?.getSummaries) return null;
	      const list = this.momentSummaryStore.getSummaries() || [];
	      const arr = Array.isArray(list) ? list : [];
	      if (!arr.length) return null;
	      const latest = arr.slice(-3);
	      const rows = [];
	      try {
	        const compacted = this.momentSummaryStore.getCompactedSummary?.();
	        const compactedText = String(compacted?.text || '').trim();
	        if (compactedText) rows.push(formatMemoryPromptText(
	          'memory.summary.long_line',
	          '- 大总结：{value}',
	          { value: compactedText },
	        ));
	      } catch {}
	      latest.forEach((it, idx) => {
	        const text = String((typeof it === 'string') ? it : it?.text || '').trim();
	        if (!text) return;
	        const at = (typeof it === 'object' && it && it.at) ? Number(it.at) : 0;
	        const isNewest = idx === latest.length - 1;
	        const when = (isNewest && at) ? formatSinceInParens(at) : '';
	        rows.push(`- ${text}${when ? formatMemoryPromptText(
	          'memory.summary.relative_suffix',
	          '（{value}）',
	          { value: when },
	        ) : ''}`);
	      });
	      if (!rows.length) return null;
	      return {
	        role: 'system',
	        content: `${formatMemoryPromptText(
	          'memory.summary.moments_header',
	          '以下为动态摘要回顾（仅供理解上下文）：',
	        )}\n${rows.join('\n')}`.trim(),
	      };
	    };

	    const buildGroupMemberPrivateSummaryBlock = () => {
	      if (!isGroupChat) return null;
	      const memberIds = groupMemberIds.slice();
	      if (!memberIds.length || !this.chatStore?.getSummaries) return null;
	      const sections = [];
	      for (let i = 0; i < memberIds.length; i++) {
	        const mid = String(memberIds[i] || '').trim();
	        if (!mid) continue;
	        const display = String(groupMemberNames[i] || '') || this.contactsStore?.getContact?.(mid)?.name || mid;
	        const compacted = this.chatStore?.getCompactedSummary?.(mid) || null;
	        const list = this.chatStore.getSummaries(mid) || [];
	        const arrRaw = Array.isArray(list) ? list : [];
	        // A) Group injection rule:
	        // 1) no compacted summary -> latest 3
	        // 2) has compacted summary -> compacted + latest 2
	        const arr = compacted ? arrRaw.slice(-2) : arrRaw.slice(-3);
	        const items = [];
	        if (compacted && String(compacted.text || '').trim()) {
	          items.push(formatMemoryPromptText('memory.summary.compacted_line', '- 总结：{value}', {
	            value: String(compacted.text).trim(),
	          }));
	        }
	        for (let j = 0; j < arr.length; j++) {
	          const it = arr[j];
	          const text = String((typeof it === 'string') ? it : it?.text || '').trim();
	          if (!text) continue;
	          const at = (typeof it === 'object' && it && it.at) ? Number(it.at) : 0;
	          const isNewest = j === arr.length - 1;
	          const when = (isNewest && at) ? formatSinceInParens(at) : '';
	          items.push(`- ${text}${when ? formatMemoryPromptText(
	            'memory.summary.relative_suffix',
	            '（{value}）',
	            { value: when },
	          ) : ''}`);
	        }
	        if (items.length) {
	          sections.push(`${formatMemoryPromptText(
	            'memory.summary.pair',
	            '{user}与{name}:',
	            { user: name1, name: display },
	          )}\n${items.join('\n')}`);
	        }
	      }
	      if (!sections.length) return null;
	      return {
	        role: 'system',
	        content: [
	          formatMemoryPromptText('memory.summary.member_private_header', '群聊成员私聊摘要回顾（YAML，仅供理解上下文）：'),
	          formatMemoryPromptText('memory.summary.member_private_note', '（私聊信息默认不对其他成员公开）'),
	          ...sections,
	        ].join('\n'),
	      };
	    };

	    const buildPrivateSummaryBlockForTarget = (targetSessionId, displayName) => {
	      const sid = String(targetSessionId || '').trim();
	      if (!sid || !this.chatStore?.getSummaries) return null;
	      const name = String(displayName || '').trim() || sid;
	      const compacted = this.chatStore?.getCompactedSummary?.(sid) || null;
	      const list = this.chatStore.getSummaries(sid) || [];
	      const arrRaw = Array.isArray(list) ? list : [];
	      const arr = compacted ? arrRaw.slice(-2) : arrRaw.slice(-3);
	      const items = [];
	      if (compacted && String(compacted.text || '').trim()) {
	        items.push(formatMemoryPromptText('memory.summary.compacted_line', '- 总结：{value}', {
	          value: String(compacted.text).trim(),
	        }));
	      }
	      for (let j = 0; j < arr.length; j++) {
	        const it = arr[j];
	        const text = String((typeof it === 'string') ? it : it?.text || '').trim();
	        if (!text) continue;
	        const at = (typeof it === 'object' && it && it.at) ? Number(it.at) : 0;
	        const isNewest = j === arr.length - 1;
	        const when = (isNewest && at) ? formatSinceInParens(at) : '';
	        items.push(`- ${text}${when ? formatMemoryPromptText(
	          'memory.summary.relative_suffix',
	          '（{value}）',
	          { value: when },
	        ) : ''}`);
	      }
	      if (!items.length) return null;
	      return {
	        role: 'system',
	        content: [
	          formatMemoryPromptText('memory.summary.private_header', '私聊摘要回顾（YAML，仅供理解上下文）：'),
	          formatMemoryPromptText('memory.summary.private_note', '（私聊信息默认不对第三方公开）'),
	          formatMemoryPromptText('memory.summary.pair', '{user}与{name}:', { user: name1, name }),
	          ...items,
	        ].join('\n'),
	      };
	    };

      const buildWorldInjectionPlan = () => {
        const worldBuckets = {
          beforeChar: [],
          afterChar: [],
          beforeScenario: [],
          afterScenario: [],
          beforeExamples: [],
          afterExamples: [],
          defaultPrompt: [],
          afterPrompt: [],
          depth: [],
        };
        const templateInject = {
          generateBeforeEntries: [],
          generateAfterEntries: [],
          generateIndexEntries: [],
          generateRegexEntries: [],
          hasTemplateTags: false,
        };
        const worldDebugRaw = {
          insertionStrategy: 'role_first',
          variableDefineStrategy: 'legacy_eager',
          budgetTokens: null,
          usedTokens: 0,
          overflowed: false,
          builtinEntries: [],
          globalEntries: [],
          roleEntries: [],
          sessionEntries: [],
          mergedEntries: [],
          trimmedEntries: [],
          injectedEntries: [],
	          templateEntries: [],
	          initialVariableEntries: [],
	          dynamicWorld: null,
	          dynamicProfiles: null,
	        };
	        const dynamicProfilesFromContext =
	          context?.meta?.dynamicProfileDebug && typeof context.meta.dynamicProfileDebug === 'object'
	            ? context.meta.dynamicProfileDebug
	            : null;
	        if (dynamicProfilesFromContext) {
	          worldDebugRaw.dynamicProfiles = dynamicProfilesFromContext;
	        }
        const builtinPhoneFormatEntries = [];
        const captureWorldDebugEntry = (target, entry, extra = {}) => {
          if (!target || !entry) return;
          target.push({ entry, ...extra });
        };
        {
          const worldSettings = this.getWorldGlobalSettings?.() || this.worldGlobalSettings || {};
          const insertionStrategy = normalizeWorldInsertionStrategy(worldSettings.insertionStrategy, 'role_first');
          const variableDefineStrategy = normalizeWorldVariableDefineStrategy(
            worldSettings.variableDefineStrategy,
            'legacy_eager',
          );
          worldDebugRaw.insertionStrategy = insertionStrategy;
          worldDebugRaw.variableDefineStrategy = variableDefineStrategy;
          const collectEntries = (worldId, overrideMatchContext = null) => this.collectWorldEntries(worldId, {
            matchText,
            matchContext: overrideMatchContext || matchContext,
          });
          const pushEntry = (entry, meta = {}) => {
            const sourceKind = String(meta?.sourceKind || entry?._src || '').trim() || 'session';
            const commentRaw = String(entry?.comment || '');
            if (/\[InitialVariables\]/i.test(commentRaw)) {
              captureWorldDebugEntry(worldDebugRaw.initialVariableEntries, entry, {
                sourceKind,
                injectMode: 'initial_variables',
              });
              if (!variableRuntimeEnabled) return;
              try {
                const raw = processTextMacrosWithPendingFlag(entry?.content || '', macroContext);
                const parsed = JSON.parse(String(raw || '').trim() || '{}');
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  Object.entries(parsed).forEach(([key, value]) => {
                    const name = String(key || '').trim();
                    if (!name) return;
                    this.chatStore?.setInitialVariable?.(name, value, sessionId);
                  });
                }
              } catch (err) {
                logger.warn('InitialVariables parse failed', err);
              }
              return;
            }
            const tags = parseTemplateInjectTags(commentRaw);
            if (tags.length) {
              captureWorldDebugEntry(worldDebugRaw.templateEntries, entry, {
                sourceKind,
                injectMode: 'template',
                tags,
              });
              templateInject.hasTemplateTags = true;
              tags.forEach(tag => {
                if (tag.stage !== 'generate') return;
                if (tag.type === 'edge') {
                  if (tag.mode === 'before') templateInject.generateBeforeEntries.push(entry);
                  if (tag.mode === 'after') templateInject.generateAfterEntries.push(entry);
                  return;
                }
                if (tag.type === 'index') {
                  templateInject.generateIndexEntries.push({
                    entry,
                    index: Number(tag.index) || 0,
                    mode: tag.mode === 'after' ? 'after' : 'before',
                  });
                  return;
                }
                if (tag.type === 'regex') {
                  templateInject.generateRegexEntries.push({
                    entry,
                    pattern: String(tag.pattern || ''),
                    mode: tag.mode === 'after' ? 'after' : 'before',
                  });
                }
              });
              return;
            }
            const pos = Number.isFinite(Number(entry?.position)) ? Math.trunc(Number(entry.position)) : 0;
            let bucket = 'defaultPrompt';
            switch (pos) {
              case 0:
                bucket = 'defaultPrompt';
                worldBuckets.defaultPrompt.push(entry);
                break;
              case 1:
                bucket = 'afterPrompt';
                worldBuckets.afterPrompt.push(entry);
                break;
              case 2:
                bucket = 'beforeScenario';
                worldBuckets.beforeScenario.push(entry);
                break;
              case 3:
                bucket = 'afterScenario';
                worldBuckets.afterScenario.push(entry);
                break;
              case 4:
                bucket = 'depth';
                worldBuckets.depth.push(entry);
                break;
              case 5:
                bucket = 'beforeExamples';
                worldBuckets.beforeExamples.push(entry);
                break;
              case 6:
                bucket = 'afterExamples';
                worldBuckets.afterExamples.push(entry);
                break;
              default:
                worldBuckets.defaultPrompt.push(entry);
                break;
            }
            captureWorldDebugEntry(worldDebugRaw.injectedEntries, entry, {
              sourceKind,
              bucket,
              injectMode: 'bucket',
            });
          };
          const pushEntries = (entries, meta = {}) => {
            const list = Array.isArray(entries) ? entries : [];
            list.forEach(entry => pushEntry(entry, meta));
          };
          if (!disablePhoneFormat) {
            const builtinEntries = this.buildPhoneFormatPromptEntries(syspActive, {
              momentCreateRules: shouldEmbedMomentCreateInPhoneFormat && momentCreateEnabled ? momentCreateRules : '',
              momentMediaMode: settingsSnapshot.autoImagePromptMomentMediaMode,
              autoImagePromptEnabled: Boolean(autoImagePromptRules),
            });
            builtinEntries.forEach(entry => captureWorldDebugEntry(worldDebugRaw.builtinEntries, entry, {
              sourceKind: 'builtin',
            }));
            builtinPhoneFormatEntries.push(...builtinEntries);
          }
          const globalEntries = [];
          resolvedWorldState.globalWorldIds.forEach((id) => {
            if (!id) return;
            globalEntries.push(...collectEntries(id));
          });
          globalEntries.forEach(entry => captureWorldDebugEntry(worldDebugRaw.globalEntries, entry, {
            sourceKind: 'global',
          }));
          const roleEntries = [];
          resolvedWorldState.roleWorldIds.forEach((id) => {
            if (!id) return;
            const entries = collectEntries(id);
            if (!entries.length) return;
            const tagged = entries.map(entry => ({ ...entry, _src: 'role' }));
            tagged.forEach(entry => captureWorldDebugEntry(worldDebugRaw.roleEntries, entry, {
              sourceKind: 'role',
            }));
            roleEntries.push(...tagged);
          });
          let sessionEntries = [];
          if (isMomentCommentTask) {
            const contacts = [
              ...(this.contactsStore?.listContacts?.() || []),
              ...(this.contactsStore?.listGroups?.() || []).map((group) => {
                const rawId = String(group?.id || '').trim();
                return {
                  ...(group || {}),
                  id: rawId && !rawId.startsWith('group:') ? `group:${rawId}` : rawId,
                  isGroup: true,
                };
              }),
            ];
            const dynamicResolution = resolveMomentWorldStrongSources({
              text: matchText,
              mentions: context?.task?.mentions || [],
              contacts,
              targetSessionId: context?.task?.targetSessionId,
              targetName: context?.task?.targetName,
              replyToAuthor: context?.task?.replyToAuthor,
              mode: context?.task?.mode,
              maxSources: 3,
              getWorldIdsForSession: sid => this.getWorldIdsForSession(sid)
                .filter(worldId => worldId !== BUILTIN_PHONE_FORMAT_WORLDBOOK_ID),
            });
            const rawSessionEntries = [];
            const seenDynamicWorldIds = new Set();
            dynamicResolution.selectedSources.forEach((source) => {
              (Array.isArray(source?.worldIds) ? source.worldIds : []).forEach((worldId) => {
                const id = String(worldId || '').trim();
                if (!id || seenDynamicWorldIds.has(id)) return;
                seenDynamicWorldIds.add(id);
                const entries = collectEntries(id, {
                  ...matchContext,
                  sessionId: String(source?.sessionId || matchContext.sessionId || '').trim(),
                  sessionName: String(source?.name || matchContext.sessionName || '').trim(),
                });
                entries.forEach(entry => rawSessionEntries.push({
                  ...entry,
                  _src: 'session',
                  _momentTriggerReason: (source.reasons || []).join(','),
                  _momentTriggerName: source.name,
                  _momentTriggerSessionId: source.sessionId,
                  _momentTriggerType: source.type,
                }));
              });
            });
            const sessionBudgetTokens = resolveMomentSessionWorldBudgetTokens(this.getWorldBudgetTokens?.());
            const limitedSessionEntries = limitMomentWorldEntriesByBudget(rawSessionEntries, {
              budgetTokens: sessionBudgetTokens,
              tokenMode: this.activeTokenEstimateMode || 'rough',
            });
            sessionEntries = limitedSessionEntries.entries;
            worldDebugRaw.dynamicWorld = {
              enabled: true,
              candidates: (dynamicResolution.candidates || []).map(item => ({
                sessionId: String(item?.sessionId || '').trim(),
                name: String(item?.name || '').trim(),
                type: String(item?.type || '').trim(),
                reasons: Array.isArray(item?.reasons) ? item.reasons.slice() : [],
                worldIds: Array.isArray(item?.worldIds) ? item.worldIds.slice() : [],
              })),
              selectedSources: (dynamicResolution.selectedSources || []).map(item => ({
                sessionId: String(item?.sessionId || '').trim(),
                name: String(item?.name || '').trim(),
                type: String(item?.type || '').trim(),
                reasons: Array.isArray(item?.reasons) ? item.reasons.slice() : [],
                worldIds: Array.isArray(item?.worldIds) ? item.worldIds.slice() : [],
              })),
              sessionBudgetTokens: limitedSessionEntries.budgetTokens,
              sessionUsedTokens: limitedSessionEntries.usedTokens,
              sessionTrimmedCount: limitedSessionEntries.trimmedEntries.length,
              overflowed: limitedSessionEntries.overflowed === true,
            };
            sessionEntries.forEach(entry => captureWorldDebugEntry(worldDebugRaw.sessionEntries, entry, {
              sourceKind: 'session',
              triggerReason: entry?._momentTriggerReason,
              triggerSourceName: entry?._momentTriggerName,
              triggerSessionId: entry?._momentTriggerSessionId,
              triggerType: entry?._momentTriggerType,
            }));
            limitedSessionEntries.trimmedEntries.forEach(entry => captureWorldDebugEntry(worldDebugRaw.trimmedEntries, entry, {
              sourceKind: 'session',
              trimReason: 'moment_session_budget',
              triggerReason: entry?._momentTriggerReason,
              triggerSourceName: entry?._momentTriggerName,
              triggerSessionId: entry?._momentTriggerSessionId,
              triggerType: entry?._momentTriggerType,
            }));
          } else {
            resolvedWorldState.sessionWorldIds.forEach((id) => {
              if (!id) return;
              const entries = collectEntries(id);
              if (!entries.length) return;
              sessionEntries.push(...entries.map(entry => ({ ...entry, _src: 'session' })));
            });
            sessionEntries.forEach(entry => captureWorldDebugEntry(worldDebugRaw.sessionEntries, entry, {
              sourceKind: 'session',
            }));
          }
          const mergedDetail = this.mergeWorldEntriesDetailed(globalEntries, [...roleEntries, ...sessionEntries], insertionStrategy);
          worldDebugRaw.budgetTokens = mergedDetail.budgetTokens;
          worldDebugRaw.usedTokens = mergedDetail.usedTokens;
          worldDebugRaw.overflowed = mergedDetail.overflowed === true;
          (mergedDetail.entries || []).forEach(entry => captureWorldDebugEntry(worldDebugRaw.mergedEntries, entry, {
            sourceKind: entry?._src || 'session',
          }));
          (mergedDetail.trimmedEntries || []).forEach(entry => captureWorldDebugEntry(worldDebugRaw.trimmedEntries, entry, {
            sourceKind: entry?._src || 'session',
          }));
          pushEntries(mergedDetail.entries, {});
        }

        const roleMap = { 0: 'system', 1: 'user', 2: 'assistant' };
        const bucketLabels = {
          beforeChar: '角色描述前',
          afterChar: '角色描述后',
          beforeScenario: '作者备注前',
          afterScenario: '作者备注后',
          beforeExamples: '示例前',
          afterExamples: '示例后',
          defaultPrompt: 'World Info (before)',
          afterPrompt: 'World Info (after)',
          depth: '按深度插入',
        };
        const buildStickerListData = () => {
          const state = stickerPackStore.getState();
          const activeSessionId = String(this.activeSessionId || '').trim();
          const keywords = [];
          const seen = new Set();
          const addKeyword = (value) => {
            const key = String(value || '').trim();
            if (!key || seen.has(key)) return;
            seen.add(key);
            keywords.push(key);
          };
          if (state.defaultEnabled !== false) {
            listMediaAssets('sticker').forEach((item) => {
              addKeyword(item?.label || item?.id || '');
            });
          }
          (state.packs || []).forEach((pack) => {
            const boundSessions = Array.isArray(pack?.boundSessions)
              ? pack.boundSessions.map(item => String(item || '').trim()).filter(Boolean)
              : [];
            const bound = activeSessionId && boundSessions.includes(activeSessionId);
            if (!pack?.aiEnabled && !bound) return;
            (pack.stickers || []).forEach((sticker) => {
              addKeyword(sticker?.keyword || '');
            });
          });
          return {
            hasKeywords: keywords.length > 0,
            keywords,
            block: `<表情包列表>\n${keywords.join('\n')}\n</表情包列表>`,
          };
        };
        const stickerListData = buildStickerListData();
        const removeStickerInstructionBlock = (text) => String(text || '')
          .replace(/\n*【表情包相关】[\s\S]*?(?=\n【转账消息相关】|\n【语音消息相关】|\n【音乐分享消息相关】|\n【图片或视频消息相关】|\n格式解释:|\n<\/QQ聊天格式介绍>|$)/g, '')
          .replace(/\n*<表情包列表>[\s\S]*?<\/表情包列表>/g, '');
        const injectStickerList = (text) => {
          const raw = String(text || '');
          if (!raw.includes('<表情包列表>')) return raw;
          if (!stickerListData.hasKeywords) return removeStickerInstructionBlock(raw);
          return raw.replace(/<表情包列表>[\s\S]*?<\/表情包列表>/g, stickerListData.block);
        };
        const formatWorldEntryContent = (entry, { applyRegex = true } = {}) => {
          const raw = processTextMacrosWithPendingFlag(entry?.content || '', macroContext);
          const injected = injectStickerList(raw);
          const trimmed = trimEdgeBlankLines(injected);
          if (!trimmed) return '';
          if (!applyRegex) return trimmed;
          return this.regex.apply(trimmed, this.getRegexContext(), regex_placement.WORLD_INFO, {
            isMarkdown: false,
            isPrompt: true,
            isEdit: false,
            depth: 0,
          });
        };
        const buildWorldMessages = (entries, { forHistory = false } = {}) => {
          const list = Array.isArray(entries) ? entries : [];
          const out = [];
          list.forEach((entry, idx) => {
            const content = formatWorldEntryContent(entry, { applyRegex: true });
            if (!content) return;
            const role = roleMap[entry?.role] || 'system';
            let finalContent = content;
            if (forHistory && role !== 'system') {
              const normalized = normalizeHistoryLineBreaks(content, role, { preserveParagraphs: preserveCreativeHistoryParagraphs });
              const speaker = role === 'assistant' ? name2 : name1;
              finalContent = withSpeakerPrefix(normalized, speaker);
            }
	            out.push({
	              role,
	              content: finalContent,
	              depth: Number(entry?.depth) || 0,
	              _seq: Number.isFinite(Number(entry?._seq)) ? entry._seq : idx,
	              promptAnchor: entry?.promptAnchor || entry?.latestUserAnchor || entry?.anchor,
	              promptOrder: Number.isFinite(Number(entry?.order)) ? Number(entry.order) : idx,
	              promptSource: 'world',
	            });
          });
          return out;
        };
        const buildDebugPreview = (entry) => {
          const formatted = formatWorldEntryContent(entry, { applyRegex: false });
          const text = trimEdgeBlankLines(formatted || entry?.content || '');
          return text.replace(/\s+/g, ' ').slice(0, 120);
        };
        const sanitizeWorldDebugTitle = (entry) => {
          const raw = String(entry?._entryTitle || entry?.comment || entry?.title || entry?.name || '')
            .replace(/\[[^\]]+\]/g, '')
            .trim();
          return raw || String(entry?._entryId || '').trim() || '未命名条目';
        };
        const sanitizeWorldDebugBlockTitle = (entry) => {
          const fallbackId = String(entry?._blockId || 'legacy').trim() || 'legacy';
          const raw = String(entry?._blockTitle || '').trim();
          if (raw) return raw;
          if (fallbackId === 'legacy') return 'legacy';
          return fallbackId;
        };
        const resolveWorldDebugFocusNodeId = (entry) => {
          const direct = String(entry?._focusNodeId || '').trim();
          if (direct) return direct;
          const blockId = String(entry?._blockId || '').trim();
          if (!blockId || blockId === 'legacy') return '';
          const blocks = Array.isArray(entry?.promptBlocks) ? entry.promptBlocks : [];
          const block = blocks.find(item => String(item?.id || '').trim() === blockId) || null;
          const graph = block?.nodeGraph && typeof block.nodeGraph === 'object' ? block.nodeGraph : null;
          if (!graph) return '';
          const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
          const edges = Array.isArray(graph.edges) ? graph.edges : [];
          if (!nodes.length || !edges.length) return '';
          const resultNode = nodes.find(node => String(node?.type || '').trim().toLowerCase() === 'result');
          const resultId = String(resultNode?.id || '').trim();
          if (!resultId) return '';
          const edge = edges.find(item => String(item?.to || '').trim() === resultId && String(item?.toPort || '').trim() === 'in');
          return String(edge?.from || '').trim();
        };
        const mapWorldDebugEntries = (list = []) => list.map((item) => {
          const entry = item?.entry || {};
          const tags = Array.isArray(item?.tags) ? item.tags : [];
          const position = Number.isFinite(Number(entry?.position)) ? Math.trunc(Number(entry.position)) : 0;
          return {
            sourceKind: String(item?.sourceKind || entry?._src || '').trim() || 'session',
            worldId: String(entry?._sourceWorldId || '').trim(),
            refWorldId: String(entry?._refWorldId || '').trim(),
            entryId: String(entry?._entryId || '').trim(),
            blockId: String(entry?._blockId || '').trim() || 'legacy',
            blockTitle: sanitizeWorldDebugBlockTitle(entry),
            focusNodeId: resolveWorldDebugFocusNodeId(entry),
            title: sanitizeWorldDebugTitle(entry),
            constant: entry?.constant === true,
            disabled: entry?.disable === true,
            keys: normalizeWorldEntryKeys(entry),
            role: roleMap[entry?.role] || 'system',
            position,
            positionLabel: bucketLabels[String(item?.bucket || '')] || bucketLabels.defaultPrompt,
            depth: Number.isFinite(Number(entry?.depth)) ? Math.max(0, Math.trunc(Number(entry.depth))) : 0,
            order: Number.isFinite(Number(entry?.order)) ? Number(entry.order) : 0,
            injectMode: String(item?.injectMode || 'bucket').trim() || 'bucket',
            bucket: String(item?.bucket || '').trim(),
            triggerReason: String(item?.triggerReason || entry?._momentTriggerReason || '').trim(),
            triggerSourceName: String(item?.triggerSourceName || entry?._momentTriggerName || '').trim(),
            triggerSessionId: String(item?.triggerSessionId || entry?._momentTriggerSessionId || '').trim(),
            triggerType: String(item?.triggerType || entry?._momentTriggerType || '').trim(),
            trimReason: String(item?.trimReason || '').trim(),
            tags: tags.map(tag => ({
              stage: String(tag?.stage || '').trim(),
              type: String(tag?.type || '').trim(),
              mode: String(tag?.mode || '').trim(),
              index: Number.isFinite(Number(tag?.index)) ? Number(tag.index) : null,
              pattern: String(tag?.pattern || '').trim(),
            })),
            contentPreview: buildDebugPreview(entry),
          };
        });

        const isBuiltinPhoneFormatEntry = (entry) => (
          String(entry?._src || '').trim() === 'builtin'
          || String(entry?._entryId || '').trim().startsWith('手机-格式')
        );
        const worldPromptBuiltinBlocks = [];
        const worldPromptDefaultRestParts = [];
        worldBuckets.defaultPrompt.forEach((entry) => {
          const content = formatWorldEntryContent(entry, { applyRegex: false });
          if (!content) return;
          if (isBuiltinPhoneFormatEntry(entry)) {
            worldPromptBuiltinBlocks.push({
              id: `phone_format_legacy_${worldPromptBuiltinBlocks.length + 1}`,
              content,
              position: 'history_before',
              depth: 1,
            });
          } else {
            worldPromptDefaultRestParts.push(content);
          }
        });
        const phoneFormatPromptBlocks = [
          ...builtinPhoneFormatEntries.map((entry, index) => ({
            id: String(entry?._transportLayerId || `phone_format_${index + 1}`).trim(),
            content: formatWorldEntryContent(entry, { applyRegex: false }),
            position: normalizePhoneFormatPromptPosition(entry?._promptPosition),
            depth: normalizePhoneFormatPromptDepth(entry?._promptDepth),
          })),
          ...worldPromptBuiltinBlocks,
        ].filter(block => block.id && String(block.content || '').trim());
        const phoneFormatPromptContent = joinPromptBlocks(
          phoneFormatPromptBlocks.map(block => block.content),
        );
        const worldPromptDefaultRest = worldPromptDefaultRestParts.join('\n\n');
        const worldPromptDefault = worldPromptDefaultRest;
        const worldPromptAfter = joinPromptBlocks(
          worldBuckets.afterPrompt.map(entry => formatWorldEntryContent(entry, { applyRegex: false })),
        );
        const worldPromptMessages = {
          beforeChar: buildWorldMessages(worldBuckets.beforeChar),
          afterChar: buildWorldMessages(worldBuckets.afterChar),
          beforeScenario: buildWorldMessages(worldBuckets.beforeScenario),
          afterScenario: buildWorldMessages(worldBuckets.afterScenario),
          beforeExamples: buildWorldMessages(worldBuckets.beforeExamples),
          afterExamples: buildWorldMessages(worldBuckets.afterExamples),
        };
        const depthWorldMessages = buildWorldMessages(worldBuckets.depth, { forHistory: true });
        const materializeInjectMessages = (entry) => (
          buildWorldMessages([entry]).map(msg => ({ role: msg.role, content: msg.content }))
        );
        const templateInjectPlan = {
          generateBefore: templateInject.generateBeforeEntries.flatMap(materializeInjectMessages),
          generateAfter: templateInject.generateAfterEntries.flatMap(materializeInjectMessages),
          generateIndex: templateInject.generateIndexEntries.map(item => ({
            index: Math.max(0, Math.trunc(Number(item.index) || 0)),
            mode: item.mode === 'after' ? 'after' : 'before',
            messages: materializeInjectMessages(item.entry),
          })).filter(item => item.messages.length > 0),
          generateRegex: templateInject.generateRegexEntries.map(item => ({
            regex: buildRegexFromTag(item.pattern),
            mode: item.mode === 'after' ? 'after' : 'before',
            messages: materializeInjectMessages(item.entry),
          })).filter(item => item.regex && item.messages.length > 0),
          hasTemplateTags: templateInject.hasTemplateTags,
        };
        const mappedMergedEntries = mapWorldDebugEntries(worldDebugRaw.mergedEntries);
        const downgradeMemoryItems = [
          ...(Array.isArray(this.lastMemoryPlan?.items) ? this.lastMemoryPlan.items : []),
          ...(Array.isArray(this.lastMemoryPlan?.recallItems) ? this.lastMemoryPlan.recallItems : []),
        ];
        const worldDebug = {
          insertionStrategy: worldDebugRaw.insertionStrategy,
          variableDefineStrategy: worldDebugRaw.variableDefineStrategy,
          budgetTokens: worldDebugRaw.budgetTokens,
	          usedTokens: worldDebugRaw.usedTokens,
	          overflowed: worldDebugRaw.overflowed,
	          tokenEstimateCoefficient: Number(this.activeTokenEstimateMode?.coefficient) || 1,
          builtinEntries: mapWorldDebugEntries(worldDebugRaw.builtinEntries),
          globalEntries: mapWorldDebugEntries(worldDebugRaw.globalEntries),
          roleEntries: mapWorldDebugEntries(worldDebugRaw.roleEntries),
          sessionEntries: mapWorldDebugEntries(worldDebugRaw.sessionEntries),
          mergedEntries: mappedMergedEntries,
          trimmedEntries: mapWorldDebugEntries(worldDebugRaw.trimmedEntries),
          injectedEntries: mapWorldDebugEntries(worldDebugRaw.injectedEntries),
	          templateEntries: mapWorldDebugEntries(worldDebugRaw.templateEntries),
	          initialVariableEntries: mapWorldDebugEntries(worldDebugRaw.initialVariableEntries),
	          dynamicWorld: worldDebugRaw.dynamicWorld,
	          dynamicProfiles: worldDebugRaw.dynamicProfiles,
	          downgradeSuggestions: buildWorldbookDowngradeSuggestions({
	            entries: mappedMergedEntries,
	            memoryItems: downgradeMemoryItems,
	          }),
	        };

        return {
          worldPromptDefault,
          worldPromptBuiltin: phoneFormatPromptContent,
          phoneFormatPromptContent,
          phoneFormatPromptBlocks,
          worldPromptDefaultRest,
          worldPromptAfter,
          worldPromptMessages,
          depthWorldMessages,
          stickerKeywords: stickerListData.keywords.slice(),
          templateInject: templateInjectPlan,
          debug: worldDebug,
        };
      };

      const cloneWorldPromptMessages = (buckets) => ({
        beforeChar: Array.isArray(buckets?.beforeChar) ? [...buckets.beforeChar] : [],
        afterChar: Array.isArray(buckets?.afterChar) ? [...buckets.afterChar] : [],
        beforeScenario: Array.isArray(buckets?.beforeScenario) ? [...buckets.beforeScenario] : [],
        afterScenario: Array.isArray(buckets?.afterScenario) ? [...buckets.afterScenario] : [],
        beforeExamples: Array.isArray(buckets?.beforeExamples) ? [...buckets.beforeExamples] : [],
        afterExamples: Array.isArray(buckets?.afterExamples) ? [...buckets.afterExamples] : [],
      });

	      const chatGuidePlan = buildChatGuidePlan();
	      const worldInjectionPlan = buildWorldInjectionPlan();
      this.lastWorldInjectionDebug = worldInjectionPlan?.debug || null;
	      const momentCommentProtocolRules = isMomentCommentTask
	        ? (isPublishedMomentCommentTask
	          ? (momentPublishCommentEnabled ? momentPublishCommentRules : '')
	          : (momentCommentEnabled ? momentCommentRules : ''))
	        : '';
	      const structuredTableTargets = includeTableEditInFormatReminder
	        && Array.isArray(this.lastMemoryPlan?.tableTargets)
	        ? this.lastMemoryPlan.tableTargets.map(target => ({
	            id: String(target?.id || '').trim(),
	            name: String(target?.name || target?.id || '').trim(),
	            rowIds: Array.isArray(target?.rowIds) ? target.rowIds.slice() : [],
	          })).filter(target => target.id && target.name)
	        : [];
	      const structuredCapabilities = {
	        momentPost: !isMomentCommentTask && Boolean(momentCreateEnabled && String(momentCreateRules || '').trim()),
	        momentCommentSideChats: isMomentCommentTask && context?.task?.allowSideEffects === true,
	        imagePrompt: !isMomentCommentTask && Boolean(String(autoImagePromptRules || '').trim()),
	        tableEdit: includeTableEditInFormatReminder && structuredTableTargets.length > 0,
	        variableUpdate: false,
	        summary: Boolean(String(summaryRules || '').trim()),
	      };
	      const removableProtocolBlocks = [
	        { id: 'memory_guide', content: String(memoryGuidePrompt?.content || '') },
	        { id: 'summary', content: String(summaryRules || '') },
	        { id: 'auto_image_prompt', content: String(autoImagePromptRules || '') },
	        {
	          id: 'moment_create',
	          content: !shouldEmbedMomentCreateInPhoneFormat ? String(momentCreateRules || '') : '',
	        },
	        { id: 'moment_comment', content: String(momentCommentProtocolRules || '') },
	      ].filter(entry => entry.content.trim());
	      const semanticSources = [
	        { id: 'memory_guide', content: String(memoryGuidePrompt?.content || '') },
	        { id: 'summary', content: String(summaryRules || '') },
	        { id: 'auto_image_prompt', content: String(autoImagePromptRules || '') },
	        { id: 'moment_create', content: String(momentCreateRules || '') },
	        { id: 'moment_comment', content: String(momentCommentProtocolRules || '') },
	      ].filter(entry => entry.content.trim());
	      this.lastPhoneFormatTransportPlan = {
	        usesBuiltinContract: formatReminderPlan.usesBuiltinContract === true,
	        usesDefaultPreset: isDefaultOpenAIPreset,
	        protocolParserEnabled: isMomentCommentTask
	          ? true
	          : (isGroupChat
	            ? groupEnabled && Boolean(String(groupRules || '').trim())
	            : dialogueEnabled && Boolean(String(dialogueRules || '').trim())),
	        hasUnsupportedSideEffects: Boolean(
	          (momentCreateEnabled && String(momentCreateRules || '').trim())
	          || String(summaryRules || '').trim()
	          || String(autoImagePromptRules || '').trim()
	          || includeTableEditInFormatReminder
	        ),
	        hasUnsupportedBatchSideEffects: includeTableEditInFormatReminder
	          && structuredTableTargets.length === 0,
	        requiresBatch: formatReminderSurface !== 'private_chat'
	          || Object.values(structuredCapabilities).some(Boolean),
	        structuredCapabilities,
	        tableTargets: structuredTableTargets,
	        removableProtocolBlocks,
	        semanticSources,
	        transportLayersDeferred: deferPhoneTransportLayers,
	        deferredLegacyLayers,
	        momentCommentDataContent: '',
	        stickerKeywords: Array.isArray(worldInjectionPlan?.stickerKeywords)
	          ? worldInjectionPlan.stickerKeywords.slice()
	          : [],
	        phoneFormatPromptLayers: Array.isArray(worldInjectionPlan?.phoneFormatPromptBlocks)
	          ? worldInjectionPlan.phoneFormatPromptBlocks.map(block => ({
	              id: String(block?.id || '').trim(),
	              content: trimEdgeBlankLines(block?.content || ''),
	            })).filter(block => block.id && block.content)
	          : [],
	        phoneFormatPromptContent: trimEdgeBlankLines(worldInjectionPlan?.phoneFormatPromptContent || ''),
	        outputFormatReminder: String(formatReminderPlan.systemText || ''),
	        scenarioReminder: scenarioFormatReminder,
	        surface: formatReminderSurface,
	        responseTarget: replyTarget,
	      };
	      const mergeDepthMessages = (...lists) => {
        const out = [];
        let seq = 0;
        lists.forEach(list => {
          const arr = Array.isArray(list) ? list : [];
          arr.forEach(msg => {
            if (!msg) return;
            out.push({ ...msg, _seq: seq++ });
          });
        });
        return out;
      };
	      const phoneFormatPromptPlan = {
	        after_persona: [],
	        system_end: [],
	        history_before: [],
	        depthMessages: [],
	      };
	      (Array.isArray(worldInjectionPlan?.phoneFormatPromptBlocks)
	        ? worldInjectionPlan.phoneFormatPromptBlocks
	        : []).forEach((rawBlock, index) => {
	        const id = String(rawBlock?.id || `phone_format_${index + 1}`).trim();
	        const content = trimEdgeBlankLines(rawBlock?.content || '');
	        if (!id || !content) return;
	        const position = normalizePhoneFormatPromptPosition(rawBlock?.position);
	        const depth = normalizePhoneFormatPromptDepth(rawBlock?.depth);
	        let injectedContent = content;
	        if (deferPhoneTransportLayers) {
	          const marker = createTransportAnchorMarker(id);
	          deferredLegacyLayers.push({ id, content, marker });
	          injectedContent = marker;
	        }
	        const message = {
	          role: 'system',
	          content: injectedContent,
	          depth,
	          promptOrder: 5560 + index,
	          promptSeq: index,
	          promptSource: id,
	        };
	        if (position === 'history_depth') {
	          phoneFormatPromptPlan.depthMessages.push(message);
	        } else {
	          phoneFormatPromptPlan[position].push(message);
	        }
	      });
	      const insertPhoneFormatAt = (slot) => {
	        const key = String(slot || '').trim();
	        const list = Array.isArray(phoneFormatPromptPlan[key]) ? phoneFormatPromptPlan[key] : [];
	        if (!list.length) return;
	        const content = joinPromptBlocks(list.map(item => item.content));
	        if (content) messages.push(buildSyntheticMessage('system', content));
	        list.length = 0;
	      };
	      const buildPhoneFormatDepthMessages = () => {
	        const grouped = new Map();
	        phoneFormatPromptPlan.depthMessages.forEach((message) => {
	          const depth = normalizePhoneFormatPromptDepth(message?.depth);
	          if (!grouped.has(depth)) grouped.set(depth, []);
	          grouped.get(depth).push(message);
	        });
	        phoneFormatPromptPlan.depthMessages.length = 0;
	        return Array.from(grouped.entries()).map(([depth, list]) => ({
	          role: 'system',
	          content: joinPromptBlocks(list.map(item => item.content)),
	          depth,
	          promptOrder: list[0]?.promptOrder ?? 5560,
	          promptSeq: list[0]?.promptSeq ?? 0,
	          promptSource: 'phone_format',
	        })).filter(message => message.content);
	      };
      const buildMemoryDepthZeroMessages = (hasPendingLatest) => {
        const depthZeroAnchor = hasPendingLatest
          ? PROMPT_SEGMENT_ANCHORS.BEFORE_LATEST_USER
          : PROMPT_SEGMENT_ANCHORS.AFTER_LATEST_USER;
        const items = [
          {
            message: memoryGuideInjector.popLatestUserPosition(PROMPT_SEGMENT_ANCHORS.BEFORE_LATEST_USER),
            anchor: PROMPT_SEGMENT_ANCHORS.BEFORE_LATEST_USER,
            order: 2000,
            source: 'memory_guide',
          },
          {
            message: memoryDataInjector.popLatestUserPosition(PROMPT_SEGMENT_ANCHORS.BEFORE_LATEST_USER),
            anchor: PROMPT_SEGMENT_ANCHORS.BEFORE_LATEST_USER,
            order: 2010,
            source: 'memory_data',
          },
          {
            message: memoryGuideInjector.popDepthZero(),
            anchor: depthZeroAnchor,
            order: 2000,
            source: 'memory_guide',
          },
          {
            message: memoryDataInjector.popDepthZero(),
            anchor: depthZeroAnchor,
            order: 2010,
            source: 'memory_data',
          },
          {
            message: memoryGuideInjector.popLatestUserPosition(PROMPT_SEGMENT_ANCHORS.AFTER_LATEST_USER),
            anchor: PROMPT_SEGMENT_ANCHORS.AFTER_LATEST_USER,
            order: 2000,
            source: 'memory_guide',
          },
          {
            message: memoryDataInjector.popLatestUserPosition(PROMPT_SEGMENT_ANCHORS.AFTER_LATEST_USER),
            anchor: PROMPT_SEGMENT_ANCHORS.AFTER_LATEST_USER,
            order: 2010,
            source: 'memory_data',
          },
        ];
        return items
          .filter(item => item.message)
          .map((item, idx) => ({
            ...item.message,
            promptAnchor: item.anchor,
            promptOrder: item.order,
            promptSeq: idx,
            promptSource: item.source,
          }));
      };
      const buildLatestUserPromptSegments = ({
        beforeLatestMessages = [],
        afterLatestMessages = [],
        memoryDepthZeroMessages = [],
        hasPendingLatest = false,
      } = {}) => {
        const memoryFallbackAnchor = hasPendingLatest
          ? PROMPT_SEGMENT_ANCHORS.BEFORE_LATEST_USER
          : PROMPT_SEGMENT_ANCHORS.AFTER_LATEST_USER;
        const memorySegments = memoryDepthZeroMessages
          .map((msg, idx) => toPromptSegment(msg, {
            fallbackAnchor: memoryFallbackAnchor,
            fallbackOrder: 2000 + (idx * 10),
            fallbackSeq: idx,
          }))
          .filter(Boolean);
        return {
          before: sortPromptSegments([...(beforeLatestMessages || []), ...memorySegments]
            .filter(item => item?.anchor === PROMPT_SEGMENT_ANCHORS.BEFORE_LATEST_USER)),
          after: sortPromptSegments([
            ...(afterLatestMessages || []),
            ...memorySegments.filter(item => item?.anchor === PROMPT_SEGMENT_ANCHORS.AFTER_LATEST_USER),
          ]),
        };
      };
      const appendPromptSegmentsToMessages = (segments) => {
        sortPromptSegments(segments).forEach(segment => {
          if (!segment?.content) return;
          messages.push(buildSyntheticMessage(segment.role || 'system', segment.content));
        });
      };
	      const summarizePromptSegments = (segments) => (Array.isArray(segments) ? segments : []).map(segment => ({
	        source: segment.source || '',
	        role: segment.role || 'system',
	        anchor: segment.anchor || '',
	        order: Number.isFinite(Number(segment.order)) ? Number(segment.order) : 0,
	        preview: String(segment.content || '').replace(/\s+/g, ' ').trim().slice(0, 120),
	      }));
	      const applyWorldTemplateInject = () => {
	        try {
	          const inject = worldInjectionPlan?.templateInject || null;
	          if (!inject) return;
	          const findLastUserIndex = () => {
	            for (let i = messages.length - 1; i >= 0; i--) {
	              if (messages[i]?.role === 'user') return i;
	            }
	            return -1;
	          };
	          const insertAt = (idx, list) => {
	            if (!list || !list.length) return 0;
	            const safe = Math.max(0, Math.min(messages.length, idx));
	            const normalizedList = normalizeSyntheticMessageList(list);
	            messages.splice(safe, 0, ...normalizedList);
	            return normalizedList.length;
	          };
	          if (Array.isArray(inject.generateBefore) && inject.generateBefore.length) {
	            insertAt(0, inject.generateBefore);
	          }
	          if (Array.isArray(inject.generateAfter) && inject.generateAfter.length) {
	            const userIdx = findLastUserIndex();
	            const at = userIdx >= 0 ? userIdx + 1 : messages.length;
	            insertAt(at, inject.generateAfter);
	          }
	          if (Array.isArray(inject.generateIndex) && inject.generateIndex.length) {
	            const sorted = [...inject.generateIndex].sort((a, b) => (a.index || 0) - (b.index || 0));
	            let offset = 0;
	            sorted.forEach(item => {
	              const base = Math.max(0, Math.trunc(Number(item.index) || 0));
	              const mode = item.mode === 'after' ? 'after' : 'before';
	              const at = base + offset + (mode === 'after' ? 1 : 0);
	              offset += insertAt(at, item.messages || []);
	            });
	          }
	          if (Array.isArray(inject.generateRegex) && inject.generateRegex.length) {
	            inject.generateRegex.forEach(item => {
	              const re = item.regex;
	              if (!re) return;
	              const idx = messages.findIndex(msg => {
	                if (!msg) return false;
	                const text = stringifyMessageContent(msg.content);
	                return re.test(text);
	              });
	              if (idx < 0) return;
	              const mode = item.mode === 'after' ? 'after' : 'before';
	              const at = idx + (mode === 'after' ? 1 : 0);
	              insertAt(at, item.messages || []);
	            });
	          }
	        } catch (err) {
	          logger.warn('template inject apply failed', err);
	        }
	      };
	      const insertDepthMessages = (history, depthMessages) => {
        const list = Array.isArray(depthMessages) ? depthMessages : [];
        if (!list.length) return;
        const baseLen = history.length;
        const inserts = list
          .map((msg, idx) => {
            const depth = Math.max(0, Math.trunc(Number(msg.depth || 0)));
            return {
              ...msg,
              _seq: Number.isFinite(Number(msg._seq)) ? msg._seq : idx,
              _index: Math.max(0, baseLen - depth),
            };
          })
          .sort((a, b) => {
            if (a._index !== b._index) return a._index - b._index;
            return a._seq - b._seq;
          });
        let offset = 0;
        inserts.forEach(item => {
          history.splice(item._index + offset, 0, buildSyntheticMessage(item.role, item.content));
          offset += 1;
        });
      };

		    if (useOpenAIPreset && openp && openaiOrder && openaiOrder.length) {
      const historyRaw = Array.isArray(context.history) ? context.history.slice() : [];
      // ST promptOnly scripts: apply to outgoing prompt only
      const history = historyRaw.map((m, idx) => {
        const role = m?.role === 'user' ? 'user' : 'assistant';
        const content = String(m?.content ?? '');
        const depth = historyRaw.length - 1 - idx; // 0 = last message
        const placement = role === 'user' ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT;
        const out = this.regex.apply(content, this.getRegexContext(), placement, {
          isMarkdown: false,
          isPrompt: true,
          isEdit: false,
          depth,
        });
        const speaker = role === 'assistant' && isGroupChat
          ? (String(m?.name || '').trim() || name2)
          : (role === 'user' ? name1 : name2);
        const normalized = normalizeHistoryLineBreaks(out, role, { preserveParagraphs: preserveCreativeHistoryParagraphs });
        return { role, content: withSpeakerPrefix(normalized, speaker) };
      });

      const pendingUserHistoryEntry = (pendingUserPrompt || hasUserAttachments)
        ? { role: 'user', content: pendingUserContent }
        : null;
      let pendingUserInsertIndex = -1;
      const insertPendingUserIntoHistory = () => {
        if (!appendUserToHistory || usedLastUserMessageForPendingInput || !pendingUserHistoryEntry) return;
        if (pendingUserInsertIndex >= 0) return;
        pendingUserInsertIndex = messages.length;
        messages.push(pendingUserHistoryEntry);
        if (hasUserAttachments) attachmentsInserted = true;
      };
      const removePendingUserFromHistory = () => {
        if (pendingUserInsertIndex < 0) return;
        messages.splice(pendingUserInsertIndex, 1);
        pendingUserInsertIndex = -1;
        if (hasUserAttachments) attachmentsInserted = false;
      };

      // 聊天提示词：按 ST 位置注入（IN_PROMPT/BEFORE_PROMPT 相对 main；IN_CHAT 按 depth/role）。
      // 世界书条目可按 position/@Depth 插入，其余默认仍走 worldInfo marker。

      const prompts = Array.isArray(openp.prompts) ? openp.prompts : [];
      const byId = new Map();
	      prompts.forEach(p => {
	        if (p?.identifier) byId.set(p.identifier, p);
	      });
	      const openaiOrderConsumesLastUser = openaiOrder.some((item) => {
	        const identifier = item?.identifier;
	        if (!identifier || item?.enabled === false) return false;
	        const pr = byId.get(identifier);
	        if (!pr || typeof pr !== 'object') return false;
	        let raw = typeof pr?.content === 'string' ? pr.content : '';
	        if (identifier === 'main' && !raw) {
	          if (useSysprompt && sysp?.content) raw = sysp.content;
	          else if (context.systemPrompt) raw = context.systemPrompt;
	        }
	        if (!hasLastUserMessagePlaceholder(raw)) return false;
	        const role = String(pr?.role || 'system').toLowerCase();
	        const mappedRole = pr?.system_prompt === true
	          ? 'system'
	          : normalizeSyntheticRoleForCheck(role);
	        return canPlaceholderConsumePendingUser(mappedRole, { synthetic: true });
	      });
	      if (!usedLastUserMessageForPendingInput && (extraPromptPlan.consumesLastUser || openaiOrderConsumesLastUser)) {
	        usedLastUserMessageForPendingInput = true;
	      }

	      const formatScenario = processTextMacrosWithPendingFlag(scenarioFormat, macroContext);
      const formatPersonality = processTextMacrosWithPendingFlag(personalityFormat, macroContext);
      const phoneFormatDepthMessages = buildPhoneFormatDepthMessages();
      const worldPromptDefaultRest = worldInjectionPlan.worldPromptDefaultRest || '';
      const worldPromptAfter = worldInjectionPlan.worldPromptAfter || '';
      const worldPromptMessages = cloneWorldPromptMessages(worldInjectionPlan.worldPromptMessages);
      const depthWorldMessages = Array.isArray(worldInjectionPlan.depthWorldMessages)
        ? [...worldInjectionPlan.depthWorldMessages]
        : [];
      const personaDepthMessages = (() => {
        if (!personaText || personaPosition !== 4) return [];
        const roleMap = { 0: 'system', 1: 'user', 2: 'assistant' };
        return [{
          role: roleMap[personaRole] || 'system',
          content: personaText,
          depth: personaDepth,
        }];
      })();
	      const depthPromptMessages = mergeDepthMessages(
	        phoneFormatDepthMessages,
	        chatGuidePlan.depthMessages,
	        depthWorldMessages,
	        personaDepthMessages,
	        extraPromptPlan.depthMessages,
	      );
	      const hasPendingLatestForDepth = Boolean(pendingUserHistoryEntry && !usedLastUserMessageForPendingInput);
      const {
        historyMessages: depthPromptHistoryMessages,
        beforeLatestMessages: depthPromptBeforeLatestMessages,
        afterLatestMessages: depthPromptAfterLatestMessages,
      } = splitDepthPromptMessagesForLatest(depthPromptMessages, {
        hasPendingLatest: hasPendingLatestForDepth,
        defaultDepthZeroAnchor: PROMPT_SEGMENT_ANCHORS.AFTER_LATEST_USER,
      });
      insertDepthMessages(history, depthPromptHistoryMessages);
      insertMemoryPromptIntoHistory(history, { hasPendingLatest: hasPendingLatestForDepth });
      const memoryDepthZeroMessages = buildMemoryDepthZeroMessages(hasPendingLatestForDepth);
      const latestUserPromptSegments = buildLatestUserPromptSegments({
        beforeLatestMessages: depthPromptBeforeLatestMessages,
        afterLatestMessages: depthPromptAfterLatestMessages,
        memoryDepthZeroMessages,
        hasPendingLatest: hasPendingLatestForDepth,
      });
      this.lastPromptSegmentDebug = {
        branch: 'openai_prompt_order',
        beforeLatest: summarizePromptSegments(latestUserPromptSegments.before),
        afterLatest: summarizePromptSegments(latestUserPromptSegments.after),
      };

      // WORLD_INFO only carries real world info markers. Extension prompts use ST positions below.
      const chatGuideContent = chatGuidePlan.promptContent;
      const chatGuideBeforePromptContent = chatGuidePlan.beforePromptContent;
      const chatGuideDepthContent = chatGuidePlan.depthContent;
      const applyWorldInfoRegexForPrompt = (text) => {
        const raw = String(text || '').trim();
        if (!raw) return '';
        return this.regex.apply(raw, this.getRegexContext(), regex_placement.WORLD_INFO, {
          isMarkdown: false,
          isPrompt: true,
          isEdit: false,
          depth: 0,
        });
      };
      const worldBeforeForPrompt = applyWorldInfoRegexForPrompt(worldPromptDefaultRest);
      const worldAfterForPrompt = applyWorldInfoRegexForPrompt(worldPromptAfter);
      const formatWorldBefore = worldBeforeForPrompt ? wiFormat.replace('{0}', worldBeforeForPrompt) : '';
      const formatWorldAfter = worldAfterForPrompt ? wiFormat.replace('{0}', worldAfterForPrompt) : '';
      let worldBeforeInserted = false;
      let worldAfterInserted = false;
      let chatGuideBeforePromptInserted = false;
      let chatGuidePromptInserted = false;
      let chatGuideAfterHistoryInserted = false;
      let depthBeforeLatestInserted = false;
      let depthAfterLatestInserted = false;
      const appendChatGuideBeforePrompt = () => {
        if (chatGuideBeforePromptInserted || !chatGuideBeforePromptContent) return;
        messages.push({ role: 'system', content: chatGuideBeforePromptContent });
        chatGuideBeforePromptInserted = true;
      };
      const appendChatGuidePrompt = () => {
        if (chatGuidePromptInserted || !chatGuideContent) return;
        messages.push({ role: 'system', content: chatGuideContent });
        chatGuidePromptInserted = true;
      };
      const insertDepthBeforeLatestMessages = () => {
        if (depthBeforeLatestInserted) return;
        appendPromptSegmentsToMessages(latestUserPromptSegments.before);
        depthBeforeLatestInserted = true;
      };
      const insertDepthAfterLatestMessages = () => {
        if (depthAfterLatestInserted) return;
        appendPromptSegmentsToMessages(latestUserPromptSegments.after);
        depthAfterLatestInserted = true;
      };
      const insertChatGuideAfterHistory = () => {
        if (chatGuideAfterHistoryInserted || !chatGuideDepthContent) return;
        messages.push({ role: 'system', content: chatGuideDepthContent });
        chatGuideAfterHistoryInserted = true;
      };
      const appendWorldBucket = key => {
        const bucket = worldPromptMessages[key];
        if (!bucket || !bucket.length) return;
        bucket.forEach(msg => messages.push(buildSyntheticMessage(msg.role || 'system', msg.content)));
        worldPromptMessages[key] = [];
      };

      const resolveMarker = identifier => {
        switch (identifier) {
          case 'worldInfoBefore':
            if (!formatWorldBefore || worldBeforeInserted) return '';
            worldBeforeInserted = true;
            return formatWorldBefore;
          case 'worldInfoAfter':
            if (!formatWorldAfter || worldAfterInserted) return '';
            worldAfterInserted = true;
            return formatWorldAfter;
          case 'charDescription':
            return processTextMacrosWithPendingFlag(context?.character?.description || '', macroContext);
          case 'charPersonality':
            return formatPersonality || '';
          case 'scenario':
            return formatScenario || '';
          case 'personaDescription':
            return personaPosition === 0 ? personaText : '';
          // dialogueExamples/chatHistory are markers without content here
          default:
            return '';
        }
      };

      let historyInserted = false;
      const sessionSummary = (() => {
        if (!useSummaryMemory) return { compacted: null, summaries: [] };
        try {
          // Group chat requirement: last 10 OR (compacted + last 3).
          // Non-group: keep previous behavior (last 30).
          return getSessionSummaryItems(sessionIdForSummary, {
            limitPlain: 30,
            limitPlainGroup: 10,
            limitWithCompacted: 30, // unused for non-group
            limitWithCompactedGroup: 3,
          });
        } catch {
          return { compacted: null, summaries: [] };
        }
      })();
      const historyRecallBlocks = (() => {
	        const blocks = [];
	          blocks.push({ role: 'system', content: historyRecallNotice });
	        const momentData = buildMomentCommentDataBlock();
	        if (momentData) blocks.push(momentData);
	        if (useSummaryMemory) {
	          const momentSummary = buildMomentSummaryBlock();
	          if (momentSummary) blocks.push(momentSummary);
	          try {
	            const compactedText = String(sessionSummary?.compacted?.text || '').trim();
	            const summaries = Array.isArray(sessionSummary?.summaries) ? sessionSummary.summaries : [];
	            if (isGroupChat) {
	              const rows = [];
	              if (compactedText) rows.push(formatMemoryPromptText(
	                'memory.summary.long_line',
	                '- 大总结：{value}',
	                { value: compactedText },
	              ));
	              rows.push(
	                ...summaries
	                  .map(s => String(typeof s === 'string' ? s : s?.text || '').trim())
	                  .filter(Boolean)
	                  .map(t => `- ${t}`),
	              );
	              if (rows.length) {
	                blocks.push({
	                  role: 'system',
	                  content: `${formatMemoryPromptText(
	                    'memory.summary.group_history_header',
	                    '以下为该群聊的摘要回顾：',
	                  )}\n${rows.join('\n')}`.trim(),
	                });
	              }
	            } else {
	              if (summaries.length) {
	                blocks.push({
	                  role: 'system',
	                  content: `${formatMemoryPromptText(
	                    'memory.summary.private_history_header',
	                    '以下为该聊天室的简要摘要回顾：',
	                  )}\n${summaries
	                    .map(s => `- ${String(typeof s === 'string' ? s : s?.text || '').trim()}`)
	                    .filter(Boolean)
	                    .join('\n')}`.trim(),
	                });
	              }
	            }
	          } catch {}

            try {
              const groupSummary = buildPrivateChatMemberGroupSummaryBlock();
              if (groupSummary) blocks.push(groupSummary);
            } catch {}
	          const priv = buildGroupMemberPrivateSummaryBlock();
	          if (priv) blocks.push(priv);
	          if (isMomentCommentTask) {
	            const targetId = String(context?.task?.targetSessionId || '').trim();
	            const targetName = String(context?.task?.targetName || '').trim();
	            const t = buildPrivateSummaryBlockForTarget(targetId, targetName);
	            if (t) blocks.push(t);
	          }
	        }
        return blocks;
      })();

      for (const item of openaiOrder) {
        const identifier = item?.identifier;
        const enabled = item?.enabled !== false;
        if (!identifier || !enabled) continue;

	        if (identifier === 'chatHistory') {
	          insertMemoryPromptAt('after_persona');
	          insertPhoneFormatAt('after_persona');
	          insertExtraPromptAt('after_persona');
	          insertMemoryPromptAt('system_end');
	          insertPhoneFormatAt('system_end');
	          insertExtraPromptAt('system_end');
	          insertMemoryPromptAt('before_chat');
	          insertExtraPromptAt('before_chat');
	          insertPhoneFormatAt('history_before');
	          insertMemoryPromptBeforeHistory();
	          insertExtraPromptAt('history_before');
		      messages.push(...historyRecallBlocks);
	          if (history.length) messages.push(...history);
	          insertMemoryPromptAfterHistory();
	          insertExtraPromptAt('history_after');
	          insertTimeContextAfterHistory();
          insertDepthBeforeLatestMessages();
          insertPendingUserIntoHistory();
          if (!pendingUserHistoryEntry || pendingUserInsertIndex >= 0 || usedLastUserMessageForPendingInput) {
            insertDepthAfterLatestMessages();
          }
          insertChatGuideAfterHistory();
          historyInserted = true;
          continue;
        }

        const pr = byId.get(identifier);
        const isMarker =
          Boolean(pr?.marker) ||
          [
            'chatHistory',
            'dialogueExamples',
            'worldInfoBefore',
            'worldInfoAfter',
            'charDescription',
            'charPersonality',
            'scenario',
            'personaDescription',
          ].includes(identifier);

        if (isMarker) {
          if (identifier === 'charDescription') {
            appendWorldBucket('beforeChar');
            const content = resolveMarker(identifier);
            if (content) messages.push({ role: 'system', content });
            appendWorldBucket('afterChar');
            continue;
          }
          if (identifier === 'scenario') {
            const content = resolveMarker(identifier);
            if (content) messages.push({ role: 'system', content });
            continue;
          }
          if (identifier === 'dialogueExamples') {
            appendWorldBucket('beforeExamples');
            const content = resolveMarker(identifier);
            if (content) messages.push({ role: 'system', content });
            appendWorldBucket('afterExamples');
            continue;
          }
	          if (identifier === 'personaDescription') {
	            const content = resolveMarker(identifier);
	            if (content) messages.push({ role: 'system', content });
	            insertMemoryPromptAt('after_persona');
	            insertPhoneFormatAt('after_persona');
	            insertExtraPromptAt('after_persona');
	            continue;
	          }
          const content = resolveMarker(identifier);
          if (content) messages.push({ role: 'system', content });
          continue;
        }

        // Custom/editable prompt block
        const rawPromptContent = typeof pr?.content === 'string' ? pr.content : '';
        const normalizedRawPromptContent = String(rawPromptContent || '').replace(/\s+/g, ' ').trim();
        const hasExplicitPromptContent =
          Boolean(normalizedRawPromptContent) &&
          normalizedRawPromptContent !== DEFAULT_OPENAI_MAIN_PROMPT;
        let content = rawPromptContent;
        // Special case: main prompt fallback
        if (identifier === 'main' && !content) {
          if (useSysprompt && sysp?.content) content = sysp.content;
          else if (context.systemPrompt) content = context.systemPrompt;
        }
        const rawHadLastUser = lastUserMessageRe.test(String(content || ''));
        // 预设分栏预览「区块原样」：跳过自定义区块正文的宏求值（预览可逐字映射、无 setvar 副作用），
        // 周边注入（人设/世界书/记忆等）照常求值；pending-user 记账用上面的原文测试，不受影响。
        content = context?.meta?.previewRawBlocks === true
          ? String(content || '')
          : processTextMacrosWithPendingFlag(content, macroContext);
        const isMainPrompt = identifier === 'main';
        if (isMainPrompt && suppressGenericReplyPrompt && !hasExplicitPromptContent) {
          appendWorldBucket('beforeScenario');
          appendChatGuideBeforePrompt();
          appendChatGuidePrompt();
          appendWorldBucket('afterScenario');
          continue;
        }
        if (isMainPrompt) {
          appendWorldBucket('beforeScenario');
          appendChatGuideBeforePrompt();
        }
        if (!content) {
          if (isMainPrompt) {
            appendChatGuidePrompt();
            appendWorldBucket('afterScenario');
          }
          continue;
        }

	        const role = String(pr?.role || 'system').toLowerCase();
	        const mappedRole = pr?.system_prompt === true
	          ? 'system'
	          : normalizeSyntheticRoleForCheck(role);
	        if (!usedLastUserMessageForPendingInput && rawHadLastUser && canPlaceholderConsumePendingUser(mappedRole, { synthetic: true })) {
	          usedLastUserMessageForPendingInput = true;
	          removePendingUserFromHistory();
	        }
	        messages.push(buildSyntheticMessage(pr?.system_prompt === true ? 'system' : role, content));
        if (isMainPrompt) {
          appendChatGuidePrompt();
          appendWorldBucket('afterScenario');
        }
	      }

      appendChatGuideBeforePrompt();
      appendChatGuidePrompt();
      // Flush any world buckets that didn't find their markers to avoid dropping entries.
      appendWorldBucket('beforeChar');
      appendWorldBucket('afterChar');
      appendWorldBucket('beforeScenario');
      appendWorldBucket('afterScenario');
      appendWorldBucket('beforeExamples');
      appendWorldBucket('afterExamples');

	      if (!historyInserted) {
	        insertMemoryPromptAt('after_persona');
	        insertPhoneFormatAt('after_persona');
	        insertExtraPromptAt('after_persona');
	        insertMemoryPromptAt('system_end');
	        insertPhoneFormatAt('system_end');
	        insertExtraPromptAt('system_end');
	        insertMemoryPromptAt('before_chat');
	        insertExtraPromptAt('before_chat');
	        insertPhoneFormatAt('history_before');
	        insertMemoryPromptBeforeHistory();
	        insertExtraPromptAt('history_before');
	        messages.push(...historyRecallBlocks);
	        if (history.length) messages.push(...history);
	        insertMemoryPromptAfterHistory();
	        insertExtraPromptAt('history_after');
	        insertTimeContextAfterHistory();
        insertDepthBeforeLatestMessages();
        insertPendingUserIntoHistory();
        if (!pendingUserHistoryEntry || pendingUserInsertIndex >= 0 || usedLastUserMessageForPendingInput) {
          insertDepthAfterLatestMessages();
        }
        insertChatGuideAfterHistory();
      }

	      // 摘要提示词包含在 <chat_guide> 内，与世界书一起注入。

      // Append current user message (unless already injected via {{lastUserMessage}} in prompt blocks)
      const pendingUserInserted = pendingUserInsertIndex >= 0;
      insertDepthBeforeLatestMessages();
      if (!usedLastUserMessageForPendingInput && !pendingUserInserted && (pendingUserPrompt || hasUserAttachments)) {
        messages.push({ role: 'user', content: pendingUserContent });
        if (hasUserAttachments) attachmentsInserted = true;
      }
      if (hasUserAttachments && !attachmentsInserted && attachmentOnlyContent) {
        messages.push({ role: 'user', content: attachmentOnlyContent });
	      }
	      insertDepthAfterLatestMessages();
	      applyWorldTemplateInject();
	      appendOutputFormatReminder();
	      return finalizeProviderMessages();
	    }

    const chatGuideContent = chatGuidePlan.promptContent;
    const chatGuideBeforePromptContent = chatGuidePlan.beforePromptContent;
    const chatGuideDepthContent = chatGuidePlan.depthContent;
    const phoneFormatDepthMessages = buildPhoneFormatDepthMessages();
    const worldPromptDefaultRest = worldInjectionPlan.worldPromptDefaultRest || '';
    const worldPromptAfter = worldInjectionPlan.worldPromptAfter || '';
    const worldPromptMessages = cloneWorldPromptMessages(worldInjectionPlan.worldPromptMessages);
    const depthWorldMessages = Array.isArray(worldInjectionPlan.depthWorldMessages)
      ? [...worldInjectionPlan.depthWorldMessages]
      : [];
    const applyWorldInfoRegexForPrompt = (text) => {
      const raw = String(text || '').trim();
      if (!raw) return '';
      return this.regex.apply(raw, this.getRegexContext(), regex_placement.WORLD_INFO, {
        isMarkdown: false,
        isPrompt: true,
        isEdit: false,
        depth: 0,
      });
    };
    const worldPromptBeforeForPrompt = applyWorldInfoRegexForPrompt(worldPromptDefaultRest);
    const worldPromptAfterForPrompt = applyWorldInfoRegexForPrompt(worldPromptAfter);
    const formatWorldBefore = worldPromptBeforeForPrompt ? wiFormat.replace('{0}', worldPromptBeforeForPrompt) : '';
    const formatWorldAfter = worldPromptAfterForPrompt ? wiFormat.replace('{0}', worldPromptAfterForPrompt) : '';
    const renderWorldBucket = (bucket) => {
      const list = Array.isArray(bucket) ? bucket : [];
      return joinPromptBlocks(list.map(msg => msg?.content || ''));
    };
    const consumeWorldBucket = (bucket) => {
      const text = renderWorldBucket(bucket);
      if (Array.isArray(bucket)) bucket.length = 0;
      return text;
    };
    const storyTemplate = useContext && typeof ctxp?.story_string === 'string' ? ctxp.story_string : '';
    const hasDescriptionToken = /{{\s*description\s*}}/i.test(storyTemplate);
    const hasScenarioToken = /{{\s*scenario\s*}}/i.test(storyTemplate);
    const hasExamplesToken = /{{\s*mesExamples(?:Raw)?\s*}}/i.test(storyTemplate);
    const descriptionBase = processTextMacrosWithPendingFlag(context?.character?.description || '', macroContext);
    const descriptionText = hasDescriptionToken
      ? joinPromptBlocks([consumeWorldBucket(worldPromptMessages.beforeChar), descriptionBase, consumeWorldBucket(worldPromptMessages.afterChar)])
      : descriptionBase;
    const personalityText = processTextMacrosWithPendingFlag(personalityFormat, {
      user: name1,
      char: name2,
      group: groupName || name2,
      members: membersText,
      personality: context?.character?.personality || '',
    });
    const scenarioBase = processTextMacrosWithPendingFlag(scenarioFormat, {
      user: name1,
      char: name2,
      group: groupName || name2,
      members: membersText,
      scenario: context?.character?.scenario || '',
    });
    const scenarioText = scenarioBase;
    const mesExamplesBase = '';
    const mesExamplesText = hasExamplesToken
      ? joinPromptBlocks([consumeWorldBucket(worldPromptMessages.beforeExamples), mesExamplesBase, consumeWorldBucket(worldPromptMessages.afterExamples)])
      : mesExamplesBase;
    const anchorBeforeText = joinPromptBlocks([
      consumeWorldBucket(worldPromptMessages.beforeScenario),
      chatGuideBeforePromptContent,
    ]);
    const anchorAfterText = joinPromptBlocks([
      consumeWorldBucket(worldPromptMessages.afterScenario),
      chatGuideContent,
    ]);

    const vars = {
      user: name1,
      char: name2,
      system: (() => {
        if (useSysprompt && sysp?.content) {
          return processTextMacrosWithPendingFlag(sysp.content, {
            user: name1,
            char: name2,
            group: groupName || name2,
            members: membersText,
          });
        }
        return context.systemPrompt || '';
      })(),
      description: descriptionText,
      personality: personalityText,
      scenario: scenarioText,
      persona: personaPosition === 0 ? personaText : '',
      wiBefore: formatWorldBefore,
      wiAfter: formatWorldAfter,
      loreBefore: formatWorldBefore,
      loreAfter: formatWorldAfter,
      anchorBefore: anchorBeforeText,
      anchorAfter: anchorAfterText,
      mesExamples: mesExamplesText,
      mesExamplesRaw: mesExamplesText,
      trim: '',
    };
    const worldMessagesBefore = [
      ...(worldPromptMessages.beforeChar || []),
      ...(worldPromptMessages.beforeScenario || []),
      ...(worldPromptMessages.beforeExamples || []),
    ];
    const worldMessagesAfter = [
      ...(worldPromptMessages.afterChar || []),
      ...(worldPromptMessages.afterScenario || []),
      ...(worldPromptMessages.afterExamples || []),
    ];
	    const flushWorldMessages = (queue) => {
	      const list = Array.isArray(queue) ? queue : [];
	      list.forEach(msg => {
	        if (!msg?.content) return;
	        messages.push(buildSyntheticMessage(msg.role || 'system', msg.content));
	      });
	      list.length = 0;
	    };
    const insertWorldAround = (fn) => {
      flushWorldMessages(worldMessagesBefore);
      fn();
      flushWorldMessages(worldMessagesAfter);
    };

    // 1) Context preset: render story_string as ST-like template
    const combinedStoryString =
      ctxp?.story_string && useContext
        ? processTextMacrosWithPendingFlag(renderStTemplate(ctxp.story_string, vars), {
            user: name1,
            char: name2,
            group: groupName || name2,
            members: membersText,
          })
        : '';

    // 2) Place story string according to story_string_position
    // ST: extension_prompt_types => IN_PROMPT:0, IN_CHAT:1, BEFORE_PROMPT:2, NONE:-1
    const position = Number(ctxp?.story_string_position ?? 0);
    const injectDepth = Math.max(0, Number(ctxp?.story_string_depth ?? 1));
    const injectRole = Number(ctxp?.story_string_role ?? 0);

    const shouldInsertStoryString = combinedStoryString && (position === 2 || position === 0);
    // BEFORE_PROMPT or IN_PROMPT: keep story_string as a system block, wrap world buckets around it.
    if (shouldInsertStoryString) {
      insertWorldAround(() => {
        messages.push({ role: 'system', content: combinedStoryString });
      });
    }
	    if (shouldInsertStoryString) {
	      insertMemoryPromptAt('after_persona');
	      insertPhoneFormatAt('after_persona');
	      insertExtraPromptAt('after_persona');
	    }

	    // 聊天提示词（私聊/群聊/动态/摘要）统一放入 <chat_guide>，与世界书同位置注入。

    // If context preset disabled, fall back to legacy system prompt building
	    if (!useContext) {
	      insertWorldAround(() => {
	        if (!suppressGenericReplyPrompt && context.systemPrompt) {
	          messages.push({ role: 'system', content: context.systemPrompt });
	        }
	        if (chatGuideBeforePromptContent) {
	          messages.push({ role: 'system', content: chatGuideBeforePromptContent });
	        }
	        if (!suppressGenericReplyPrompt && vars.system) {
	          messages.push({ role: 'system', content: vars.system });
	        }
	        if (formatWorldBefore) {
	          messages.push({ role: 'system', content: formatWorldBefore });
        }
        if (formatWorldAfter) {
          messages.push({ role: 'system', content: formatWorldAfter });
        }
	        if (chatGuideContent) {
	          messages.push({ role: 'system', content: chatGuideContent });
	        }
	        if (!suppressGenericReplyPrompt && context.character) {
	          let characterPrompt = formatMemoryPromptText(
	            'character.context.role',
	            '你正在扮演: {name}',
	            { name: context.character.name },
	          );
	          if (context.character.description) characterPrompt += `\n\n${formatMemoryPromptText(
	            'character.context.description',
	            '角色描述:\n{value}',
	            { value: context.character.description },
	          )}`;
	          if (context.character.personality) characterPrompt += `\n\n${formatMemoryPromptText(
	            'character.context.personality',
	            '性格特点:\n{value}',
	            { value: context.character.personality },
	          )}`;
          messages.push({ role: 'system', content: characterPrompt });
        }
      });
	    } else if (!shouldInsertStoryString) {
	      // Context preset enabled but no story_string inserted: still flush world buckets to avoid dropping entries.
	      flushWorldMessages(worldMessagesBefore);
      if (chatGuideBeforePromptContent) {
        messages.push({ role: 'system', content: chatGuideBeforePromptContent });
      }
      if (chatGuideContent) {
        messages.push({ role: 'system', content: chatGuideContent });
      }
	      flushWorldMessages(worldMessagesAfter);
	    }
	    insertMemoryPromptAt('after_persona');
	    insertPhoneFormatAt('after_persona');
	    insertExtraPromptAt('after_persona');
	    insertMemoryPromptAt('system_end');
	    insertPhoneFormatAt('system_end');
	    insertExtraPromptAt('system_end');

    // 3) History
    const stringifyPromptContent = (content) => {
      if (Array.isArray(content)) {
        const parts = content.map((part) => {
          if (!part || typeof part !== 'object') return '';
          if (part.type === 'text') return String(part.text || '');
          if (part.type === 'image_url') return '[图片]';
          if (part.type === 'input_audio') return '[语音]';
          return '';
        });
        return parts.filter(Boolean).join('\n');
      }
      return String(content ?? '');
    };
    const history = Array.isArray(context.history) ? context.history.map(m => ({ ...m })) : [];
    // Prefix speaker names to reduce model confusion (role is still preserved)
    try {
      for (const m of history) {
        if (!m || typeof m !== 'object') continue;
        if (m.role !== 'user' && m.role !== 'assistant') continue;

        const mediaUrl = typeof m.__mediaUrl === 'string' ? m.__mediaUrl.trim() : '';
        let contentText = stringifyPromptContent(m.content);

        // Prevent OOM: Replace heavy Base64 content with placeholders for LLM context
        if (!contentText) contentText = '';
        if (mediaUrl) {
          if (!contentText) contentText = '[图片]';
          if (m.role === 'user') {
            m.__media = { kind: 'image', url: mediaUrl };
          }
        } else if (m.type === 'image' || (typeof contentText === 'string' && contentText.startsWith('data:image'))) {
          contentText = '[图片]';
        } else if (m.type === 'audio' || (typeof contentText === 'string' && contentText.startsWith('data:audio'))) {
          contentText = '[语音]';
        }

        const speaker = m.role === 'assistant' && isGroupChat
          ? (String(m?.name || '').trim() || name2)
          : (m.role === 'user' ? name1 : name2);
        m.content = normalizeHistoryLineBreaks(contentText, m.role, { preserveParagraphs: preserveCreativeHistoryParagraphs });
        m.content = withSpeakerPrefix(m.content, speaker);
      }
    } catch {}

	    const postHistoryRaw = useSysprompt ? sysp?.post_history || '' : '';
	    const postHistoryConsumesLastUser =
	      hasLastUserMessagePlaceholder(postHistoryRaw) && canPlaceholderConsumePendingUser('user');
	    if (!usedLastUserMessageForPendingInput && (extraPromptPlan.consumesLastUser || postHistoryConsumesLastUser)) {
	      usedLastUserMessageForPendingInput = true;
	    }
	    const hasPendingLatestForDepth = !usedLastUserMessageForPendingInput && (pendingUserPrompt || hasUserAttachments);
    const roleMapForDepth = { 0: 'system', 1: 'user', 2: 'assistant' };
    const personaDepthMessages = (() => {
      if (!personaText || personaPosition !== 4) return [];
      return [{
        role: roleMapForDepth[personaRole] || 'system',
        content: personaText,
        depth: personaDepth,
      }];
    })();
	    const storyStringDepthMessages = (() => {
	      if (!combinedStoryString) return [];
	      if (position === 4 || position === 5) {
	        return [{
	          role: roleMapForDepth[injectRole] || 'system',
	          content: combinedStoryString,
	          depth: 0,
	          promptAnchor: position === 4
	            ? PROMPT_SEGMENT_ANCHORS.BEFORE_LATEST_USER
	            : PROMPT_SEGMENT_ANCHORS.AFTER_LATEST_USER,
	          promptOrder: 3100,
	          promptSource: 'story_string',
	        }];
	      }
	      if (position !== 1) return [];
	      return [{
	        role: roleMapForDepth[injectRole] || 'system',
	        content: combinedStoryString,
	        depth: injectDepth,
	        promptOrder: 3100,
	        promptSource: 'story_string',
	      }];
	    })();
	    const depthPromptMessages = mergeDepthMessages(
      phoneFormatDepthMessages,
      chatGuidePlan.depthMessages,
      personaDepthMessages,
	      storyStringDepthMessages,
	      depthWorldMessages,
	      extraPromptPlan.depthMessages,
	    );
    const {
      historyMessages: depthPromptHistoryMessages,
      beforeLatestMessages: depthPromptBeforeLatestMessages,
      afterLatestMessages: depthPromptAfterLatestMessages,
    } = splitDepthPromptMessagesForLatest(depthPromptMessages, {
      hasPendingLatest: hasPendingLatestForDepth,
      defaultDepthZeroAnchor: PROMPT_SEGMENT_ANCHORS.AFTER_LATEST_USER,
    });
	    insertDepthMessages(history, depthPromptHistoryMessages);
	    insertMemoryPromptIntoHistory(history, { hasPendingLatest: hasPendingLatestForDepth });
    const memoryDepthZeroMessages = buildMemoryDepthZeroMessages(hasPendingLatestForDepth);
    const latestUserPromptSegments = buildLatestUserPromptSegments({
      beforeLatestMessages: depthPromptBeforeLatestMessages,
      afterLatestMessages: depthPromptAfterLatestMessages,
      memoryDepthZeroMessages,
      hasPendingLatest: hasPendingLatestForDepth,
    });
    this.lastPromptSegmentDebug = {
      branch: 'context_template',
      beforeLatest: summarizePromptSegments(latestUserPromptSegments.before),
      afterLatest: summarizePromptSegments(latestUserPromptSegments.after),
    };
    let depthBeforeLatestInserted = false;
    let depthAfterLatestInserted = false;
    const insertDepthBeforeLatestMessages = () => {
      if (depthBeforeLatestInserted) return;
      appendPromptSegmentsToMessages(latestUserPromptSegments.before);
      depthBeforeLatestInserted = true;
    };
    const insertDepthAfterLatestMessages = () => {
      if (depthAfterLatestInserted) return;
      appendPromptSegmentsToMessages(latestUserPromptSegments.after);
      depthAfterLatestInserted = true;
    };
		    // 聊天提示词的 IN_CHAT 部分已按 depth/role 注入 history。
		    insertMemoryPromptAt('before_chat');
	      insertExtraPromptAt('before_chat');
	      insertPhoneFormatAt('history_before');
	      insertMemoryPromptBeforeHistory();
	      insertExtraPromptAt('history_before');
		    messages.push({ role: 'system', content: historyRecallNotice });
	    try {
	      const momentData = buildMomentCommentDataBlock();
	      if (momentData) messages.push(momentData);
	    } catch {}
	    if (useSummaryMemory) {
	      try {
	        const momentSummary = buildMomentSummaryBlock();
	        if (momentSummary) messages.push(momentSummary);
	      } catch {}
	      try {
	        const sessionSummary = getSessionSummaryItems(sessionIdForSummary, {
	          limitPlain: 30,
	          limitPlainGroup: 10,
	          limitWithCompacted: 30,
	          limitWithCompactedGroup: 3,
	        });
	        const compactedText = String(sessionSummary?.compacted?.text || '').trim();
	        const summaries = Array.isArray(sessionSummary?.summaries) ? sessionSummary.summaries : [];
	        if (isGroupChat) {
	          const rows = [];
	          if (compactedText) rows.push(formatMemoryPromptText(
	            'memory.summary.long_line',
	            '- 大总结：{value}',
	            { value: compactedText },
	          ));
	          rows.push(
	            ...summaries
	              .map(s => String(typeof s === 'string' ? s : s?.text || '').trim())
	              .filter(Boolean)
	              .map(t => `- ${t}`),
	          );
	          if (rows.length) {
	            messages.push({
	              role: 'system',
	              content: `${formatMemoryPromptText(
	                'memory.summary.group_history_header',
	                '以下为该群聊的摘要回顾：',
	              )}\n${rows.join('\n')}`.trim(),
	            });
	          }
	        } else {
	          if (summaries.length) {
	            messages.push({
	              role: 'system',
	              content: `${formatMemoryPromptText(
	                'memory.summary.private_history_header',
	                '以下为该聊天室的简要摘要回顾：',
	              )}\n${summaries
	                .map(s => `- ${String(typeof s === 'string' ? s : s?.text || '').trim()}`)
	                .filter(Boolean)
	                .join('\n')}`.trim(),
	            });
	          }
	        }
	      } catch {}
        try {
          const groupSummary = buildPrivateChatMemberGroupSummaryBlock();
          if (groupSummary) messages.push(groupSummary);
        } catch {}
	      try {
	        const priv = buildGroupMemberPrivateSummaryBlock();
	        if (priv) messages.push(priv);
	      } catch {}
	      if (isMomentCommentTask) {
	        try {
	          const targetId = String(context?.task?.targetSessionId || '').trim();
	          const targetName = String(context?.task?.targetName || '').trim();
	          const t = buildPrivateSummaryBlockForTarget(targetId, targetName);
	          if (t) messages.push(t);
	        } catch {}
	      }
	    }
	    if (history.length > 0) {
	      const historyForSend = history.map((msg) => {
	        if (!msg || typeof msg !== 'object') return msg;
	        const media = msg.__media;
	        const mediaUrl = media && typeof media.url === 'string' ? media.url.trim() : '';
	        if (media && media.kind === 'image' && mediaUrl) {
	          const text = String(msg.content || '').trim();
	          const parts = [];
	          if (text) parts.push({ type: 'text', text });
	          else parts.push({ type: 'text', text: '' });
	          parts.push({ type: 'image_url', image_url: { url: mediaUrl } });
	          const { __media, __mediaUrl, __mediaKind, ...rest } = msg;
	          return { ...rest, content: parts };
	        }
	        if ('__mediaUrl' in msg || '__mediaKind' in msg || '__media' in msg) {
	          const { __media, __mediaUrl, __mediaKind, ...rest } = msg;
	          return rest;
	        }
	        return msg;
	      });
	      messages.push(...historyForSend);
	    }
	      insertMemoryPromptAfterHistory();
	      insertExtraPromptAt('history_after');
		    insertTimeContextAfterHistory();
    if (chatGuideDepthContent) {
      messages.push({ role: 'system', content: chatGuideDepthContent });
    }
	    // 摘要提示词包含在 <chat_guide> 内，与世界书一起注入。

    // 4) Post-history instructions (sysprompt.post_history)
	    const postHistory = postHistoryRaw;
	    if (postHistory) {
      const phi = processTextMacrosWithPendingFlag(postHistory, { user: name1, char: name2 });
      if (phi) {
        messages.push({ role: 'user', content: phi });
      }
    }

	    // ST-style user POV reply target: keep it close to the final turn so it can override
    // the default "reply as character" framing without adding extra main-UI controls.
    if (impersonationPrompt) {
      messages.push({ role: 'system', content: impersonationPrompt });
    }

    // 5) Current user message
    insertDepthBeforeLatestMessages();
    if (!usedLastUserMessageForPendingInput && (pendingUserPrompt || hasUserAttachments)) {
      messages.push({ role: 'user', content: pendingUserContent });
      if (hasUserAttachments) attachmentsInserted = true;
    }
	    if (hasUserAttachments && !attachmentsInserted && attachmentOnlyContent) {
	      messages.push({ role: 'user', content: attachmentOnlyContent });
	    }
	    insertDepthAfterLatestMessages();
	    applyWorldTemplateInject();

	    appendOutputFormatReminder();

	    return finalizeProviderMessages();
	  }

  /**
   * SillyTavern-like generation parameters (from OpenAI preset)
   * We store the full OpenAI preset JSON, but only map common fields into provider options.
   */
  getGenerationOptions(presetContext = {}, runtimeConfigOverride = null) {
    try {
      const state = this.presets?.getState?.();
      if (!state?.enabled?.openai) return {};
      const resolved = this.presets.getResolvedActive('openai', presetContext || {});
      const p = resolved?.preset;
      if (!p || typeof p !== 'object') return {};

      const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const int = v => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined);
      const runtimeConfig = runtimeConfigOverride && typeof runtimeConfigOverride === 'object'
          ? runtimeConfigOverride
          : (this.config.get?.() || {});

      const sessionId = String(presetContext?.sessionId || '').trim();
      const sessionReasoning = sessionId
          ? this.presets.getSessionReasoning?.('openai', sessionId)
          : null;
      const modeForReasoning = normalizeBridgePresetUiMode(presetContext?.uiMode, { sessionId });
      const modeReasoning = this.presets.getModeReasoning?.('openai', modeForReasoning) || null;
      const overrideReasoning = sessionReasoning || modeReasoning;
      const effectiveRequestReasoning = overrideReasoning
          ? overrideReasoning.request_reasoning === true
          : p.request_reasoning === true;
      const effectiveReasoningEffort = overrideReasoning?.reasoning_effort
          || p.reasoning_effort;

      const base = {
        temperature: num(p.temperature),
        top_p: num(p.top_p),
        top_k: int(p.top_k),
        presence_penalty: num(p.presence_penalty),
        frequency_penalty: num(p.frequency_penalty),
        seed: int(p.seed),
        n: int(p.n),
      };

      const maxTokens = int(p.openai_max_tokens);
      const provider = runtimeConfig?.provider;
      const model = runtimeConfig?.model;
      const baseUrl = runtimeConfig?.baseUrl;
      const samplerPolicy = getReasoningSamplerPolicy({
        provider,
        model,
        baseUrl,
        requestReasoning: effectiveRequestReasoning,
      });
      const reasoningOptions = buildReasoningRequestOptions({
        provider,
        model,
        baseUrl,
        requestReasoning: effectiveRequestReasoning,
        reasoningEffort: effectiveReasoningEffort,
        maxOutputTokens: maxTokens,
      });
      if (samplerPolicy.disabledFields.includes('temperature')) delete base.temperature;
      if (samplerPolicy.disabledFields.includes('top_p')) delete base.top_p;
      if (samplerPolicy.disabledFields.includes('top_k')) delete base.top_k;
      if (samplerPolicy.disabledFields.includes('presence_penalty')) delete base.presence_penalty;
      if (samplerPolicy.disabledFields.includes('frequency_penalty')) delete base.frequency_penalty;
      if (samplerPolicy.disabledFields.includes('seed')) delete base.seed;
      if (samplerPolicy.disabledFields.includes('n')) delete base.n;
      if (typeof base.seed === 'number' && base.seed < 0) delete base.seed;

      // Provider-specific mapping
      if (provider === 'gemini' || provider === 'makersuite' || provider === 'vertexai') {
        return {
          temperature: base.temperature,
          top_p: base.top_p,
          top_k: base.top_k,
          maxTokens,
          ...reasoningOptions,
        };
      }

      if (provider === 'anthropic') {
        // our AnthropicProvider expects maxTokens (camelCase), but will pass other fields through
        return {
          temperature: base.temperature,
          top_p: base.top_p,
          top_k: base.top_k,
          maxTokens,
          ...reasoningOptions,
        };
      }

      // openai-like (openai/deepseek/custom)
      const options = {
        temperature: base.temperature,
        top_p: base.top_p,
        presence_penalty: base.presence_penalty,
        frequency_penalty: base.frequency_penalty,
        seed: base.seed,
        n: base.n,
        ...reasoningOptions,
      };
      if (typeof maxTokens === 'number') options.max_tokens = maxTokens;
      return options;
    } catch (err) {
      logger.debug('getGenerationOptions failed', err);
      return {};
    }
  }

  /**
   * 保存到聊天历史
   */
  async saveToHistory(userMessage, assistantMessage) {
    try {
      const messages = [
        {
          role: 'user',
          content: userMessage,
          timestamp: Date.now(),
        },
        {
          role: 'assistant',
          content: assistantMessage,
          timestamp: Date.now(),
        },
      ];

      await this.chatStorage.saveMessages(this.currentCharacterId, messages);
      logger.debug('聊天记录已保存');
    } catch (error) {
      logger.error('保存聊天记录失败:', error);
    }
  }

  /**
   * 获取聊天历史
   */
  async getChatHistory(characterId, limit = 50) {
    const messages = await this.chatStorage.getMessages(characterId || this.currentCharacterId, limit);
    return messages;
  }

  /**
   * 清除聊天历史
   */
  async clearChatHistory(characterId) {
    await this.chatStorage.clearMessages(characterId || this.currentCharacterId);
    logger.info('聊天记录已清除');
  }

  /**
   * 获取世界书数据（调用方拿到副本，附带不会写入 JSON 的运行时 revision 标记）。
   */
  async _getWorldInfoUnlocked(characterId) {
    const id = String(characterId || this.currentCharacterId || '').trim();
    if (!id) return null;
    if (this.worldStore.ready) {
      await this.worldStore.ready;
    }
    try {
      return await this.worldStore.ensureLoaded(id);
    } catch (err) {
      logger.debug('世界书按本读取失败，使用空白', err);
      return null;
    }
  }

  async getWorldInfoSnapshot(characterId) {
    const id = String(characterId || this.currentCharacterId || '').trim();
    if (!id) {
      return Object.freeze({ worldbookId: '', exists: false, revision: 0, generation: 0, data: null });
    }
    return await this.worldInfoConcurrency.enqueue(id, async () => {
      const data = await this._getWorldInfoUnlocked(id);
      return this.worldInfoConcurrency.snapshot(id, data);
    });
  }

  async getWorldInfo(characterId) {
    try {
      const snapshot = await this.getWorldInfoSnapshot(characterId);
      return attachWorldInfoRevisionMeta(cloneWorldInfoValue(snapshot.data), snapshot);
    } catch (error) {
      logger.error('获取世界书失败:', error);
      return {};
    }
  }

  /**
   * 独立检查世界书是否仍存在，不改变 getWorldInfo 缺失时的兼容返回语义。
   */
  async worldInfoExists(characterId) {
    const id = String(characterId || this.currentCharacterId || '').trim();
    if (!id) return false;
    if (this.worldStore.ready) {
      await this.worldStore.ready;
    }
    if (this.worldStore.has?.(id)) return true;
    try {
      return Boolean(await safeInvoke('world_info_exists', { characterId: id }));
    } catch (error) {
      if (isTauriInvokeUnavailableError(error)) return false;
      throw error;
    }
  }

  /**
   * 对照前端索引与原生 worldinfo 文件；只审计，不自动删除。
   */
  async auditWorldInfoStorage() {
    if (this.worldStore.ready) {
      await this.worldStore.ready;
    }
    const indexedIds = Array.from(new Set(this.worldStore.list()
      .map(id => String(id || '').trim())
      .filter(Boolean)))
      .sort();
    let nativeIds = [];
    try {
      nativeIds = Array.from(new Set((await safeInvoke('list_world_info_files') || [])
        .map(id => String(id || '').trim())
        .filter(Boolean)))
        .sort();
    } catch (error) {
      if (isTauriInvokeUnavailableError(error)) {
        return {
          ok: true,
          nativeAvailable: false,
          indexedIds,
          nativeIds: [],
          nativeOnlyIds: [],
          indexedOnlyIds: indexedIds,
          referencedNativeOnlyIds: [],
        };
      }
      throw error;
    }
    const indexedSet = new Set(indexedIds);
    const nativeSet = new Set(nativeIds);
    const nativeOnlyIds = nativeIds.filter(id => !indexedSet.has(id));
    const referencedIds = new Set([
      ...this.normalizeWorldIds(this.currentWorldIds),
      ...this.getGlobalWorldIds(),
      ...Object.values(this.worldSessionMap || {}).flatMap(value => this.normalizeWorldIds(value)),
    ].filter(Boolean));
    return {
      ok: true,
      nativeAvailable: true,
      indexedIds,
      nativeIds,
      nativeOnlyIds,
      indexedOnlyIds: indexedIds.filter(id => !nativeSet.has(id)),
      referencedNativeOnlyIds: nativeOnlyIds.filter(id => referencedIds.has(id)),
    };
  }

  /**
   * 保存世界书数据
   */
  async _saveWorldInfoStorage(characterId, data) {
    const id = characterId || this.currentCharacterId;
    if (this.worldStore.ready) {
      await this.worldStore.ready;
    }
    const now = Date.now();
    const base = (data && typeof data === 'object') ? data : { name: id, entries: [] };
    const existing = await this.worldStore.ensureLoaded?.(id);
    const createdAtRaw = Number(base?.createdAt || base?.created_at || existing?.createdAt || existing?.created_at || 0);
    const payload = {
      ...base,
      createdAt: Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? createdAtRaw : now,
      updatedAt: now,
    };
    try { delete payload[WORLDINFO_REVISION_META]; } catch {}
    let nativeAvailable = true;
    // 正文先原子落盘，再更新轻量索引，避免索引指向尚不存在的 sidecar。
    try {
      await safeInvoke('save_world_info', { characterId: id, data: payload });
    } catch (error) {
      if (isTauriInvokeUnavailableError(error)) nativeAvailable = false;
      else throw error;
    }
    await this.worldStore.save(id, payload, { skipNative: nativeAvailable });
    return payload;
  }

  async saveWorldInfo(characterId, data, options = {}) {
    const id = String(characterId || this.currentCharacterId || '').trim();
    try {
      return await this.worldInfoConcurrency.enqueue(id, async () => {
        const current = await this._getWorldInfoUnlocked(id);
        const latestSnapshot = this.worldInfoConcurrency.snapshot(id, current);
        const expectation = getWorldInfoWriteExpectation(data, options);
        const conflict = this.worldInfoConcurrency.validate(id, expectation);
        if (conflict) {
          const result = { ...conflict, latestSnapshot, latestData: latestSnapshot.data };
          if (options?.conflictMode === 'return') return result;
          const error = new Error('世界书已被其他操作修改，请载入最新内容后重试。');
          error.code = WORLDINFO_REVISION_CONFLICT;
          error.details = result;
          throw error;
        }
        const payload = await this._saveWorldInfoStorage(id, data);
        const metadata = this.worldInfoConcurrency.commitSave(id, payload);
        logger.debug('世界书已保存', id);
        return {
          ok: true,
          ...metadata,
          data: cloneWorldInfoValue(payload),
        };
      });
    } catch (error) {
      logger.error('保存世界书失败:', error);
      throw error;
    }
  }

  /**
   * 保存 Persona 角色卡原始数据（独立文件）
   */
  async savePersonaCard(personaId, data) {
    const id = String(personaId || '').trim();
    if (!id) throw new Error('persona id missing');
    return await safeInvoke('save_persona_card', { id, data });
  }

  /**
   * 读取 Persona 角色卡原始数据
   */
  async loadPersonaCard(personaId) {
    const id = String(personaId || '').trim();
    if (!id) return null;
    try {
      const res = await safeInvoke('load_persona_card', { id });
      return res;
    } catch (err) {
      logger.warn('load persona card failed', err);
      return null;
    }
  }

  /**
   * 删除 Persona 角色卡原始数据
   */
  async deletePersonaCard(personaId) {
    const id = String(personaId || '').trim();
    if (!id) return false;
    try {
      return await safeInvoke('delete_persona_card', { id });
    } catch (err) {
      logger.warn('delete persona card failed', err);
      return false;
    }
  }

  async cleanupPersonaScopedData(keepPersonaIds = [], deletePersonaIds = []) {
    try {
      return await safeInvoke('cleanup_persona_scoped_data', {
        keepPersonaIds: Array.isArray(keepPersonaIds) ? keepPersonaIds : [],
        deletePersonaIds: Array.isArray(deletePersonaIds) ? deletePersonaIds : [],
      });
    } catch (err) {
      logger.warn('cleanup persona scoped data failed', err);
      return { deletedScopes: [], deletedPaths: [], failedScopes: [] };
    }
  }

  async _removeWorldInfoStorage(worldId) {
    const target = String(worldId || '').trim();
    if (!target) {
      return { nativeAvailable: false, nativeDeleted: false };
    }
    let nativeAvailable = true;
    let nativeDeleted = false;
    try {
      nativeDeleted = Boolean(await safeInvoke('delete_world_info', { characterId: target }));
    } catch (error) {
      if (isTauriInvokeUnavailableError(error)) {
        nativeAvailable = false;
      } else {
        throw error;
      }
    }
    await this.worldStore.remove(target, { skipNative: nativeAvailable, nativeDeleted });
    return { nativeAvailable, nativeDeleted };
  }

  async renameWorldInfo(fromId, toId, data, options = {}) {
    const from = String(fromId || '').trim();
    const to = String(toId || '').trim();
    if (!from || !to) return;
    if (from === to) {
      return await this.saveWorldInfo(to, data, options);
    }
    if (this.worldStore.ready) {
      await this.worldStore.ready;
    }

    let mapChanged = false;
    let currentChanged = false;
    let globalChanged = false;
    let regexChanged = false;
    let roleChanged = false;
    const storageResult = await this.worldInfoConcurrency.enqueueMany([from, to], async () => {
      const sourceData = await this._getWorldInfoUnlocked(from);
      const sourceSnapshot = this.worldInfoConcurrency.snapshot(from, sourceData);
      const sourceConflict = this.worldInfoConcurrency.validate(
        from,
        getWorldInfoWriteExpectation(data, options),
      );
      if (sourceConflict) {
        const result = { ...sourceConflict, latestSnapshot: sourceSnapshot, latestData: sourceSnapshot.data };
        if (options?.conflictMode === 'return') return result;
        const error = new Error('世界书已被其他操作修改，请载入最新内容后重试。');
        error.code = WORLDINFO_REVISION_CONFLICT;
        error.details = result;
        throw error;
      }
      if (!sourceSnapshot.exists) {
        return {
          ok: false,
          reason: 'worldbook_not_found',
          worldbookId: from,
          latestSnapshot: sourceSnapshot,
          latestData: sourceSnapshot.data,
        };
      }

      const targetData = await this._getWorldInfoUnlocked(to);
      const targetSnapshot = this.worldInfoConcurrency.snapshot(to, targetData);
      if (targetSnapshot.exists) {
        return {
          ok: false,
          reason: 'worldbook_name_conflict',
          worldbookId: from,
          targetWorldbookId: to,
          latestSnapshot: sourceSnapshot,
          latestData: sourceSnapshot.data,
        };
      }

      const payload = await this._saveWorldInfoStorage(to, { ...(data || {}), name: to });
      const targetMetadata = this.worldInfoConcurrency.commitSave(to, payload);

      const map = this.worldSessionMap || {};
      for (const [sid, val] of Object.entries(map)) {
        const list = this.normalizeWorldIds(val);
        if (!list.includes(from)) continue;
        const next = Array.from(new Set(list.map(id => (id === from ? to : id)))).filter(Boolean);
        if (!next.length) delete map[sid];
        else map[sid] = next;
        mapChanged = true;
      }
      if (mapChanged) this.persistWorldSessionMap();

      if (Array.isArray(this.currentWorldIds) && this.currentWorldIds.includes(from)) {
        this.currentWorldIds = Array.from(new Set(this.currentWorldIds.map(id => (id === from ? to : id)))).filter(Boolean);
        this.currentWorldId = this.currentWorldIds[0] || null;
        currentChanged = true;
      }

      const globalWorldIds = this.getGlobalWorldIds();
      if (globalWorldIds.includes(from)) {
        this.globalWorldIds = Array.from(new Set(globalWorldIds.map(id => (id === from ? to : id)))).filter(Boolean);
        this.globalWorldId = this.globalWorldIds[0] || null;
        this.persistGlobalWorldId();
        globalChanged = true;
      }

      try {
        await this.regex?.ready;
        const sets = this.regex?.state?.local?.sets || null;
        if (sets) {
          for (const s of Object.values(sets)) {
            if (!s || typeof s !== 'object') continue;
            if (s.bind?.type !== 'world') continue;
            if (String(s.bind.worldId || '') !== from) continue;
            s.bind = { ...s.bind, worldId: to };
            s.updatedAt = Date.now();
            regexChanged = true;
          }
          if (regexChanged) await this.regex.persist();
        }
      } catch {}

      try {
        roleChanged = Boolean(await this.worldLifecycleHandler?.({ type: 'rename', from, to }));
      } catch (err) {
        logger.warn('rename role world refs failed', err);
      }

      await this._removeWorldInfoStorage(from);
      this.worldInfoConcurrency.commitDelete(from);
      return {
        ok: true,
        worldbookId: to,
        renamedFrom: from,
        ...targetMetadata,
        data: cloneWorldInfoValue(payload),
      };
    });
    if (storageResult?.ok === false) return storageResult;

    let refsChanged = false;
    try {
      const names = await this.listWorlds();
      const refCandidates = names.filter((wid) => {
        if (!wid || wid === from) return false;
        const metadata = this.worldStore?.getMetadata?.(wid) || null;
        if (!metadata || metadata.entriesCount === null) return true;
        return Array.isArray(metadata.refs) && metadata.refs.includes(from);
      });
      for (const wid of refCandidates) {
        // refs 重写在 rename 锁外逐本 CAS：并发保存会造成冲突，重读快照重试；
        // 重试耗尽仍冲突则告警，避免悬挂引用被静默跳过。
        let settled = false;
        for (let attempt = 0; attempt < 3 && !settled; attempt += 1) {
          const snapshot = await this.getWorldInfoSnapshot(wid);
          const worldData = snapshot.data;
          if (!worldData || !Array.isArray(worldData.refs)) {
            settled = true;
            break;
          }
          let changed = false;
          const nextRefs = worldData.refs.map((ref) => {
            if (!ref || typeof ref !== 'object') return ref;
            const sourceId = String(ref.sourceId || ref.worldId || ref.source || '').trim();
            if (sourceId !== from) return ref;
            changed = true;
            return { ...ref, sourceId: to };
          });
          if (!changed) {
            settled = true;
            break;
          }
          const result = await this.saveWorldInfo(wid, { ...worldData, refs: nextRefs }, {
            expectedRevision: snapshot.revision,
            expectedGeneration: snapshot.generation,
            expectedExists: true,
            conflictMode: 'return',
          });
          if (result?.ok) {
            refsChanged = true;
            settled = true;
          }
        }
        if (!settled) {
          logger.warn('rename world refs rewrite conflicted repeatedly', { worldbookId: wid, from, to });
        }
      }
    } catch {}

    if (mapChanged || currentChanged || globalChanged || refsChanged || roleChanged) {
      this.syncWorldRegexBindings?.();
      this.emitWorldInfoChanged({ renamedFrom: from, renamedTo: to });
    }
    if (regexChanged) window.dispatchEvent(new CustomEvent('regex-changed'));
    return storageResult;
  }

  /**
   * 删除世界书
   */
  async deleteWorldInfo(worldId, options = {}) {
    try {
      const target = String(worldId || '').trim();
      if (!target) return;
      return await this.worldInfoConcurrency.enqueue(target, async () => {
        const current = await this._getWorldInfoUnlocked(target);
        const latestSnapshot = this.worldInfoConcurrency.snapshot(target, current);
        const conflict = this.worldInfoConcurrency.validate(target, options);
        if (conflict) {
          const result = { ...conflict, latestSnapshot, latestData: latestSnapshot.data };
          if (options?.conflictMode === 'return') return result;
          const error = new Error('世界书已在确认后发生变化，请重新确认删除。');
          error.code = WORLDINFO_REVISION_CONFLICT;
          error.details = result;
          throw error;
        }
        const storageResult = await this._removeWorldInfoStorage(target);

        let mapChanged = false;
        for (const [sid, val] of Object.entries(this.worldSessionMap || {})) {
          const next = this.normalizeWorldIds(val).filter((id) => id !== target);
          if (next.length === this.normalizeWorldIds(val).length) continue;
          if (!next.length) delete this.worldSessionMap[sid];
          else this.worldSessionMap[sid] = next;
          mapChanged = true;
        }
        if (mapChanged) this.persistWorldSessionMap();

        let currentChanged = false;
        if (Array.isArray(this.currentWorldIds) && this.currentWorldIds.includes(target)) {
          this.currentWorldIds = this.currentWorldIds.filter((id) => id !== target);
          this.currentWorldId = this.currentWorldIds[0] || null;
          currentChanged = true;
        }
        let globalChanged = false;
        const globalWorldIds = this.getGlobalWorldIds();
        if (globalWorldIds.includes(target)) {
          this.globalWorldIds = globalWorldIds.filter(id => id !== target);
          this.globalWorldId = this.globalWorldIds[0] || null;
          this.persistGlobalWorldId();
          globalChanged = true;
        }

        let roleChanged = false;
        try {
          roleChanged = Boolean(await this.worldLifecycleHandler?.({ type: 'delete', worldId: target }));
        } catch (err) {
          logger.warn('delete role world refs failed', err);
        }

        if (mapChanged || currentChanged || globalChanged || roleChanged) {
          this.syncWorldRegexBindings?.();
          this.emitWorldInfoChanged({ deletedWorldId: target });
        }
        const metadata = this.worldInfoConcurrency.commitDelete(target);
        logger.debug('世界书已删除', worldId);
        return { ok: true, worldId: target, ...storageResult, ...metadata };
      });
    } catch (error) {
      logger.error('删除世界书失败:', error);
      throw error;
    }
  }

  async listWorlds() {
    if (this.worldStore.ready) {
      await this.worldStore.ready;
    }
    return this.worldStore.list();
  }

  async waitForWorldStoreReady() {
    if (this.worldStore?.ready) await this.worldStore.ready;
    return true;
  }

  setWorldEntriesCountBackfill(listener) {
    if (!this.worldStore || typeof this.worldStore !== 'object') return false;
    this.worldStore.onEntriesCountBackfill = typeof listener === 'function' ? listener : null;
    return true;
  }

  getWorldInfoMetadata(worldId) {
    const id = String(worldId || '').trim();
    if (!id) return null;
    return this.worldStore?.getMetadata?.(id) || null;
  }

  loadStoredWorldInfo(worldId) {
    const id = String(worldId || '').trim();
    if (!id) return null;
    const data = this.worldStore?.load?.(id) || null;
    if (!data) return null;
    const snapshot = this.worldInfoConcurrency.snapshot(id, data);
    return attachWorldInfoRevisionMeta(cloneWorldInfoValue(snapshot.data), snapshot);
  }

  hasStoredWorldInfo(worldId) {
    const id = String(worldId || '').trim();
    return Boolean(id && (this.worldStore?.has?.(id) || this.loadStoredWorldInfo(id)));
  }

  getRegexStore() {
    return this.regex || null;
  }

  async waitForRegexStoreReady() {
    if (this.regex?.ready) {
      await this.regex.ready;
    }
    return true;
  }

  getRegexSession(sessionId) {
    return this.regex?.getSession?.(sessionId) || null;
  }

  listRegexLocalSets() {
    return this.regex?.listLocalSets?.() || [];
  }

  getRegexLocalSet(setId) {
    return this.regex?.getLocalSet?.(setId) || null;
  }

  async upsertRegexLocalSet(set) {
    return await this.regex?.upsertLocalSet?.(set);
  }

  async removeRegexLocalSet(setId) {
    return await this.regex?.removeLocalSet?.(setId);
  }

  setCurrentWorld(worldId, sessionId = this.activeSessionId) {
    const sid = String(sessionId || '').trim();
    const list = this.normalizeWorldIds(worldId);
    if (sid) {
      if (!list.length) delete this.worldSessionMap[sid];
      else this.worldSessionMap[sid] = list;
      this.persistWorldSessionMap();
    }
    this.currentWorldIds = sid === this.activeSessionId ? list : this.currentWorldIds;
    this.currentWorldId = this.currentWorldIds[0] || null;
    this.syncWorldRegexBindings?.();
    this.emitWorldInfoChanged({ sessionId: sid });
  }

  /**
   * Bind a world book to a session without switching the current session world.
   * (Used by group chat to auto-enable member world books.)
   */
  bindWorldToSession(sessionId, worldId, { silent = true } = {}) {
    const sid = String(sessionId || '').trim();
    const list = this.normalizeWorldIds(worldId);
    if (!sid) return;
    if (!list.length) delete this.worldSessionMap[sid];
    else this.worldSessionMap[sid] = list;
    this.persistWorldSessionMap();
    if (!silent && sid === this.activeSessionId) {
      this.currentWorldIds = list;
      this.currentWorldId = this.currentWorldIds[0] || null;
      this.syncWorldRegexBindings?.();
      this.emitWorldInfoChanged({ sessionId: sid });
    }
  }

  getWorldIdsForSession(sessionId = this.activeSessionId) {
    return this.normalizeWorldIds(this.worldSessionMap[sessionId]);
  }

  getWorldSessionBindingSnapshot(sessionId = this.activeSessionId) {
    const sid = String(sessionId || '').trim();
    return {
      sessionId: sid,
      scopeId: String(this.scopeId || '').trim(),
      worldbookIds: sid ? this.getWorldIdsForSession(sid) : [],
    };
  }

  updateWorldSessionBinding(sessionId, options = {}) {
    const sid = String(sessionId || '').trim();
    const scopeId = String(this.scopeId || '').trim();
    if (!sid) {
      return {
        ok: false,
        conflict: false,
        reason: 'missing_session_id',
        sessionId: sid,
        scopeId,
        worldbookIds: [],
      };
    }
    if (
      Object.prototype.hasOwnProperty.call(options || {}, 'expectedScopeId') &&
      String(options.expectedScopeId || '').trim() !== scopeId
    ) {
      return {
        ok: false,
        conflict: true,
        reason: 'target_scope_changed',
        sessionId: sid,
        scopeId,
        expectedScopeId: String(options.expectedScopeId || '').trim(),
        worldbookIds: this.getWorldIdsForSession(sid),
      };
    }
    const mutation = resolveWorldSessionBindingMutation({
      currentWorldbookIds: this.getWorldIdsForSession(sid),
      expectedWorldbookIds: options.expectedWorldbookIds,
      worldbookId: options.worldbookId,
      mode: options.mode,
    });
    if (!mutation.ok) return { ...mutation, sessionId: sid, scopeId };
    if (mutation.changed) {
      this.bindWorldToSession(sid, mutation.worldbookIds, { silent: options.silent !== false });
    }
    return { ...mutation, sessionId: sid, scopeId };
  }

  getCurrentWorldId() {
    return this.currentWorldId || '';
  }

  getCurrentWorldIds() {
    return this.normalizeWorldIds(this.currentWorldIds);
  }

  getGlobalWorldId() {
    return this.getGlobalWorldIds()[0] || '';
  }

  getGlobalWorldIds() {
    return Array.from(new Set(this.normalizeWorldIds(
      Array.isArray(this.globalWorldIds) ? this.globalWorldIds : this.globalWorldId,
    )));
  }

  setSessionWorldIds(sessionId, worldIds, { silent = true } = {}) {
    const sid = String(sessionId || '').trim();
    if (!sid) return;
    const list = this.normalizeWorldIds(worldIds);
    if (!list.length) delete this.worldSessionMap[sid];
    else this.worldSessionMap[sid] = list;
    this.persistWorldSessionMap();
    if (!silent && sid === this.activeSessionId) {
      this.currentWorldIds = list;
      this.currentWorldId = this.currentWorldIds[0] || null;
      this.syncWorldRegexBindings?.();
      this.emitWorldInfoChanged({ sessionId: sid });
    }
  }

  toggleWorldForSession(sessionId, worldId, { silent = true } = {}) {
    const sid = String(sessionId || '').trim();
    const id = String(worldId || '').trim();
    if (!sid || !id) return;
    const list = this.normalizeWorldIds(this.worldSessionMap[sid]);
    const idx = list.indexOf(id);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(id);
    this.setSessionWorldIds(sid, list, { silent });
  }

  setGlobalWorld(worldId) {
    this.setGlobalWorldIds(worldId ? [worldId] : []);
  }

  setGlobalWorldIds(worldIds) {
    this.globalWorldIds = Array.from(new Set(this.normalizeWorldIds(worldIds)));
    this.globalWorldId = this.globalWorldIds[0] || null;
    this.persistGlobalWorldId();
    this.syncWorldRegexBindings?.();
    this.emitWorldInfoChanged();
  }

  toggleGlobalWorld(worldId) {
    const id = String(worldId || '').trim();
    if (!id) return;
    const next = this.getGlobalWorldIds();
    const index = next.indexOf(id);
    if (index >= 0) next.splice(index, 1);
    else next.push(id);
    this.setGlobalWorldIds(next);
  }

  getWorldGlobalSettings() {
    return { ...(this.worldGlobalSettings || this.getDefaultWorldGlobalSettings()) };
  }

  setWorldGlobalSettings(next = {}) {
    const merged = { ...(this.worldGlobalSettings || this.getDefaultWorldGlobalSettings()), ...(next || {}) };
    this.worldGlobalSettings = this.normalizeWorldGlobalSettings(merged);
    this.persistWorldGlobalSettings();
    this.emitWorldInfoChanged();
  }

  buildWorldConditionRuntimeContext(sessionId = '') {
    const sid = String(sessionId || this.activeSessionId || '').trim();
    if (this.isVariableRuntimeEnabled?.(sid) === false) {
      return buildVariableContext({ baseVars: {}, globalVars: {}, localVars: {} });
    }
    const useGlobalVariables = Boolean(
      sid
      && typeof this.isSharedVariableSession === 'function'
      && this.isSharedVariableSession(sid),
    );
    const localVars = this.chatStore?.listVariables?.(sid) || {};
    const globalVars = this.chatStore?.listGlobalVariables?.() || {};
    const baseVars = useGlobalVariables ? globalVars : localVars;
    return buildVariableContext({ baseVars, globalVars, localVars });
  }

  getWorldBudgetTokens() {
    if (
      this.activeInputBudgetPlan
      && Object.prototype.hasOwnProperty.call(this.activeInputBudgetPlan, 'worldBudgetTokens')
    ) {
      const active = this.activeInputBudgetPlan.worldBudgetTokens;
      if (active === null || active === undefined) return null;
      const normalized = Math.trunc(Number(active));
      return Number.isFinite(normalized) ? Math.max(0, normalized) : null;
    }
    const settings = this.getWorldGlobalSettings?.() || this.worldGlobalSettings || {};
    const budgetCapRaw = Number(settings.budgetCap);
    if (Number.isFinite(budgetCapRaw) && budgetCapRaw > 0) return Math.max(0, Math.trunc(budgetCapRaw));
    const percentRaw = Number(settings.contextPercent);
    if (!Number.isFinite(percentRaw) || percentRaw <= 0) return null;
    const preset = this.presets?.getActive?.('openai') || {};
    // fallback 与调度器共用同一预算公式（ctx 未知 → null 不硬顶），不再保留内联副本
    const fallbackBudget = resolveInputTokenBudget({
      maxContextTokens: preset?.openai_max_context,
      maxOutputTokens: preset?.openai_max_tokens,
      safetyReserveTokens: 512,
    });
    if (fallbackBudget.inputBudgetTokens === null) return null;
    return Math.max(0, Math.floor(fallbackBudget.inputBudgetTokens * (percentRaw / 100)));
  }

  warnWorldBudgetOverflow() {
    const now = Date.now();
    if (this.lastWorldBudgetWarningAt && now - this.lastWorldBudgetWarningAt < 5000) return;
    this.lastWorldBudgetWarningAt = now;
    window.toastr?.warning('世界书内容超过预算上限，已截断');
  }

  collectWorldEntries(worldId, label) {
    const id = String(worldId || '').trim();
    if (!id) return [];
    const data = this.worldStore.load(id);
    if (!data || typeof data !== 'object') return [];

    const labelObj = (label && typeof label === 'object') ? label : {};
    const matchContext =
      labelObj && typeof labelObj.matchContext === 'object' && labelObj.matchContext
        ? labelObj.matchContext
        : null;
    const matchTextRaw = labelObj ? String(labelObj.matchText || '') : '';
    const matchText = matchTextRaw;
    const scopeSessionId = String(matchContext?.sessionId || '').trim();
    const worldSettings = this.getWorldGlobalSettings?.() || this.worldGlobalSettings || {};
    const {
      globalCaseSensitive,
      globalMatchWholeWords,
      globalRecursiveScan,
      globalUseGroupScoring,
      minActivations,
      maxDepthSetting,
      maxRecursionStepsSetting,
      variableDefineStrategy,
    } = buildWorldActivationSettings(worldSettings);

    const runtimeSessionId = String(scopeSessionId || this.activeSessionId || '').trim();
    const variableRuntimeEnabled = this.isVariableRuntimeEnabled?.(runtimeSessionId) !== false;
    const useGlobalVariables = Boolean(
      runtimeSessionId &&
      typeof this.isSharedVariableSession === 'function' &&
      this.isSharedVariableSession(runtimeSessionId),
    );
    let runtimeConditionContext = this.buildWorldConditionRuntimeContext(runtimeSessionId);
    const refreshRuntimeConditionContext = () => {
      runtimeConditionContext = this.buildWorldConditionRuntimeContext(runtimeSessionId);
    };
    refreshRuntimeConditionContext();
    const evalConditionGroup = (when) => {
      if (!when || typeof when !== 'object') return true;
      if (!variableRuntimeEnabled && !isTrivialConditionTree(when)) return false;
      return evaluateConditionTree(when, runtimeConditionContext);
    };
    const evaluateEntryWhen = (when) => {
      if (!when || typeof when !== 'object' || isTrivialConditionTree(when)) {
        return { configured: false, passed: true, explanation: null };
      }
      if (!variableRuntimeEnabled) {
        return {
          configured: true,
          passed: false,
          explanation: { runtimeResult: false, reason: 'variable_runtime_disabled' },
        };
      }
      const explanation = explainConditionTree(when, runtimeConditionContext);
      return {
        configured: true,
        passed: explanation?.runtimeResult === true,
        explanation,
      };
    };
    const resolveBlockFocusNodeId = (graphRaw) => {
      const graph = graphRaw && typeof graphRaw === 'object' ? graphRaw : null;
      if (!graph) return '';
      const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
      const edges = Array.isArray(graph.edges) ? graph.edges : [];
      if (!nodes.length || !edges.length) return '';
      const resultNode = nodes.find(node => String(node?.type || '').trim().toLowerCase() === 'result');
      const resultId = String(resultNode?.id || '').trim();
      if (!resultId) return '';
      const edge = edges.find(
        item => String(item?.to || '').trim() === resultId && String(item?.toPort || '').trim() === 'in',
      );
      return String(edge?.from || '').trim();
    };

    const sanitizeEntryDebugTitle = (entry = {}) => {
      const raw = String(entry?.comment || entry?.title || entry?.name || '')
        .replace(/\[[^\]]+\]/g, '')
        .trim();
      return raw || String(entry?._entryId || '').trim() || '未命名条目';
    };

    const normalizePromptBlocks = (entry = {}) => {
      const blocks = Array.isArray(entry?.promptBlocks) ? entry.promptBlocks : [];
      return blocks
        .map((raw, idx) => {
          const block = raw && typeof raw === 'object' ? raw : {};
          const whenRaw = block.when && typeof block.when === 'object' ? block.when : null;
          const nodeGraph = block.nodeGraph && typeof block.nodeGraph === 'object' ? block.nodeGraph : null;
          const normalizedWhen = !isTrivialConditionTree(whenRaw)
            ? normalizeConditionTree(whenRaw, createDefaultPromptClause())
            : null;
          const blockId = String(block.id || `blk_${idx}`);
          return {
            id: blockId,
            title: String(block.title || block.name || blockId).trim() || blockId,
            enabled: block.enabled !== false,
            content: String(block.content || ''),
            role: block.role,
            priority: Number.isFinite(Number(block.priority)) ? Number(block.priority) : 100,
            when: normalizedWhen,
            nodeGraph: normalizedWhen ? nodeGraph : null,
            debugFocusNodeId: normalizedWhen ? resolveBlockFocusNodeId(nodeGraph) : '',
          };
        })
        .filter(Boolean);
    };

    const ensureDefinedVariable = (spec) => {
      const chatStore = this.chatStore;
      if (!variableRuntimeEnabled || !chatStore || !runtimeSessionId) return;
      if (!spec || typeof spec !== 'object') return;
      const name = String(spec.name || '').trim();
      if (!name) return;
      const typeRaw = String(spec.type || 'number').trim().toLowerCase();
      const type = ['number', 'string', 'boolean'].includes(typeRaw) ? typeRaw : 'number';
      const defaultValue = parseTypedValue(spec.default, type);
      const schema = chatStore.getVariableSchema?.(name, runtimeSessionId);
      if (!schema) {
        chatStore.setVariableSchema?.(name, { type, default: defaultValue }, runtimeSessionId);
      }
      if (useGlobalVariables) {
        const currentGlobal = chatStore.getGlobalVariable?.(name);
        if (currentGlobal === undefined || currentGlobal === null) {
          chatStore.setGlobalVariable?.(name, defaultValue);
        }
      } else {
        const current = chatStore.getVariable?.(name, runtimeSessionId);
        if (current === undefined || current === null) {
          chatStore.setVariable?.(name, defaultValue, runtimeSessionId);
        }
        if (chatStore.getInitialVariable?.(name, runtimeSessionId) === undefined) {
          chatStore.setInitialVariable?.(name, defaultValue, runtimeSessionId);
        }
      }
    };
    const syncPromptBlockVariableSchemas = (entry) => {
      const entrySpecs = collectConditionDefineSpecs(entry?.when, []);
      entrySpecs.forEach(spec => ensureDefinedVariable(spec));
      const blocks = normalizePromptBlocks(entry);
      blocks.forEach((block) => {
        const specs = collectConditionDefineSpecs(block?.when, []);
        specs.forEach(spec => ensureDefinedVariable(spec));
      });
    };
    const syncPromptBlockVariableSchemasForEntries = (entryList = []) => {
      const list = Array.isArray(entryList) ? entryList : [];
      if (!list.length) return false;
      list.forEach((entry) => {
        syncPromptBlockVariableSchemas(entry);
      });
      return true;
    };
    const syncEntryGateVariableSchemasForEntries = (entryList = []) => {
      const list = Array.isArray(entryList) ? entryList : [];
      if (!list.length) return false;
      list.forEach((entry) => {
        collectConditionDefineSpecs(entry?.when, []).forEach(spec => ensureDefinedVariable(spec));
      });
      return true;
    };

    const baseEntries = prepareWorldEntries({
      worldId: id,
      data,
      loadWorld: (sourceId) => this.worldStore.load(sourceId),
    });
    if (!baseEntries.length) return [];
    if (variableRuntimeEnabled && variableDefineStrategy === 'legacy_eager') {
      const changed = syncPromptBlockVariableSchemasForEntries(baseEntries);
      if (changed) refreshRuntimeConditionContext();
    } else if (variableRuntimeEnabled && variableDefineStrategy === 'first_hit') {
      // 条目门控先于“命中”运行；其变量若也等命中后才建立会形成永远无法命中的循环。
      const changed = syncEntryGateVariableSchemasForEntries(baseEntries);
      if (changed) refreshRuntimeConditionContext();
    }

    const activation = analyzeWorldEntryActivation({
      baseEntries,
      matchText,
      matchContext,
      settings: {
        globalCaseSensitive,
        globalMatchWholeWords,
        globalRecursiveScan,
        globalUseGroupScoring,
        minActivations,
        maxDepthSetting,
        maxRecursionStepsSetting,
      },
      applyProbability: true,
      evaluateEntryWhen,
    });
    if (variableRuntimeEnabled && variableDefineStrategy === 'first_hit') {
      const changed = syncPromptBlockVariableSchemasForEntries(activation.activeEntries);
      if (changed) refreshRuntimeConditionContext();
    }

    let entries = activation.activeEntries.slice();

    const trimEdgeBlankLines = (text) =>
      String(text ?? '').replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:\r?\n[ \t]*)+$/, '');

    const roleToNumber = (value, fallback = 0) => {
      if (Number.isFinite(Number(value))) return Math.max(0, Math.min(2, Math.trunc(Number(value))));
      const text = String(value || '').trim().toLowerCase();
      if (text === 'user') return 1;
      if (text === 'assistant') return 2;
      if (text === 'system') return 0;
      return Math.max(0, Math.min(2, Math.trunc(Number(fallback) || 0)));
    };
    const expanded = [];
    entries.forEach((entry, idx) => {
      const blocks = normalizePromptBlocks(entry);
      const promptMode = normalizeWorldPromptMode(entry?.promptMode, { fallback: 'hybrid' });
      const useBlocks = shouldUseWorldPromptBlocks(promptMode, blocks, { fallback: 'hybrid' });
      const fallbackRole = roleToNumber(entry?.role, 0);
      if (!useBlocks) {
        const legacyContent = trimEdgeBlankLines(entry?.content);
        if (!String(legacyContent || '').trim()) return;
        expanded.push({
          ...entry,
          content: legacyContent,
          _blockId: 'legacy',
          _blockPriority: Number.isFinite(Number(entry?.priority)) ? Number(entry.priority) : 100,
          _blockOrder: 0,
          _blockRole: fallbackRole,
          _dedupeKey: `${String(entry?._entryId || '')}::legacy`,
          _entryTitle: sanitizeEntryDebugTitle(entry),
          _blockTitle: 'legacy',
          _focusNodeId: '',
        });
        return;
      }
      blocks.forEach((block, blockIdx) => {
        if (block?.enabled === false) return;
        const blockContent = trimEdgeBlankLines(block?.content);
        if (!String(blockContent || '').trim()) return;
        if (!evalConditionGroup(block?.when)) return;
        const blockId = String(block?.id || `blk_${blockIdx}`);
        expanded.push({
          ...entry,
          content: blockContent,
          _blockId: blockId,
          _blockPriority: Number.isFinite(Number(block?.priority)) ? Number(block.priority) : 100,
          _blockOrder: blockIdx,
          _blockRole: roleToNumber(block?.role, fallbackRole),
          _dedupeKey: `${String(entry?._entryId || '')}::${blockId}`,
          _entryTitle: sanitizeEntryDebugTitle(entry),
          _blockTitle: String(block?.title || blockId).trim() || blockId,
          _focusNodeId: String(block?.debugFocusNodeId || '').trim(),
        });
      });
    });

    expanded.sort((a, b) => {
      const orderA = Number.isFinite(Number(a?.order)) ? Number(a.order) : 0;
      const orderB = Number.isFinite(Number(b?.order)) ? Number(b.order) : 0;
      if (orderA !== orderB) return orderA - orderB;
      const priorityA = Number.isFinite(Number(a?._blockPriority)) ? Number(a._blockPriority) : 100;
      const priorityB = Number.isFinite(Number(b?._blockPriority)) ? Number(b._blockPriority) : 100;
      if (priorityA !== priorityB) return priorityA - priorityB;
      const entrySeqA = Number.isFinite(Number(a?._entryIndex)) ? Number(a._entryIndex) : 0;
      const entrySeqB = Number.isFinite(Number(b?._entryIndex)) ? Number(b._entryIndex) : 0;
      if (entrySeqA !== entrySeqB) return entrySeqA - entrySeqB;
      const blockOrderA = Number.isFinite(Number(a?._blockOrder)) ? Number(a._blockOrder) : 0;
      const blockOrderB = Number.isFinite(Number(b?._blockOrder)) ? Number(b._blockOrder) : 0;
      return blockOrderA - blockOrderB;
    });

    return expanded.map((e, idx) => {
      const positionRaw = Number(e?.position);
      const depthRaw = Number(e?.depth);
      const orderRaw = Number(e?.order);
      const position = Number.isFinite(positionRaw) ? Math.trunc(positionRaw) : 0;
      const depth = Number.isFinite(depthRaw) ? Math.max(0, Math.trunc(depthRaw)) : 0;
      const role = roleToNumber(e?._blockRole, e?.role);
      const order = Number.isFinite(orderRaw) ? orderRaw : idx;
      return {
        content: String(e?.content || ''),
        comment: String(e?.comment || ''),
        title: String(e?.title || ''),
        name: String(e?.name || ''),
	        position,
	        depth,
	        role,
	        order,
	        latestUserAnchor: String(e?.latestUserAnchor || e?.promptAnchor || '').trim().toLowerCase(),
	        _seq: idx,
        _entryId: String(e?._entryId || ''),
        _blockId: String(e?._blockId || ''),
        _dedupeKey: String(e?._dedupeKey || `${String(e?._entryId || '')}::${String(e?._blockId || 'legacy')}`),
        _sourceWorldId: String(e?._sourceWorldId || ''),
        _refWorldId: String(e?._refWorldId || ''),
        _entryTitle: String(e?._entryTitle || sanitizeEntryDebugTitle(e)),
        _blockTitle: String(e?._blockTitle || e?._blockId || 'legacy'),
        _focusNodeId: String(e?._focusNodeId || '').trim(),
      };
    });
  }

  buildWorldDebugLabel({ userMessage = '', context = null } = {}) {
    const ctx = context || (this.contextBuilder ? this.contextBuilder(String(userMessage ?? '')) : null) || {};
    const sessionId = String(ctx?.session?.id || this.activeSessionId || '').trim();
    const sessionName = String(
      ctx?.session?.name ||
      this.contactsStore?.getContact?.(sessionId)?.name ||
      '',
    ).trim();
    const userName = String(ctx?.user?.name || 'user').trim() || 'user';
    const characterName = String(
      ctx?.character?.name ||
      this.contactsStore?.getContact?.(sessionId)?.name ||
      'assistant',
    ).trim() || 'assistant';
    const personaRaw = String(ctx?.user?.persona || '');
    const personaText = personaRaw
      ? processTextMacrosWithPendingFlag(personaRaw, { user: userName, char: characterName })
      : '';
    const stringifyMatchContent = (content) => {
      if (Array.isArray(content)) {
        return content
          .map((part) => (part?.type === 'text' ? String(part.text || '') : ''))
          .filter(Boolean)
          .join('\n');
      }
      return String(content ?? '');
    };
    const historyForMatch = Array.isArray(ctx.history) ? ctx.history : [];
    const globalWorldSettings = this.getWorldGlobalSettings?.() || this.worldGlobalSettings || {};
    const includeNames = globalWorldSettings.includeNames === true;
    const fullHistoryLines = historyForMatch
      .map((m) => {
        const content = stringifyMatchContent(m?.content);
        if (!content) return '';
        if (!includeNames) return content;
        const role = String(m?.role || '').trim();
        const speaker = String(m?.name || (role === 'user' ? userName : role === 'assistant' ? characterName : '') || '').trim();
        return speaker ? `${speaker}: ${content}` : content;
      })
      .filter(Boolean);
    let historyMatchLines = [...fullHistoryLines];
    const globalScanDepthRaw = globalWorldSettings.scanDepth;
    const globalScanDepth = Number.isFinite(Number(globalScanDepthRaw)) ? Math.max(0, Math.trunc(Number(globalScanDepthRaw))) : null;
    if (globalScanDepth !== null) {
      historyMatchLines = historyMatchLines.slice(-globalScanDepth);
    }
    const uiModeRaw = String(ctx?.meta?.uiMode || ctx?.uiMode || '').trim().toLowerCase();
    const uiMode = uiModeRaw === 'rp' ? 'rp' : 'chat';
    const matchText = [String(userMessage ?? ''), ...historyMatchLines].join('\n');
    return {
      matchText,
      matchContext: {
        userMessage: String(userMessage ?? ''),
        history: historyMatchLines,
        fullHistory: fullHistoryLines,
        personaText,
        sessionId,
        sessionName,
        uiMode,
        groupMemberNames: Array.isArray(ctx?.group?.memberNames)
          ? ctx.group.memberNames.map(String).filter(Boolean)
          : [],
        character: {
          description: String(ctx?.character?.description || ''),
          personality: String(ctx?.character?.personality || ''),
          scenario: String(ctx?.character?.scenario || ''),
          depthPrompt: String(ctx?.character?.depthPrompt || ''),
          creatorNotes: String(ctx?.character?.creatorNotes || ''),
        },
      },
    };
  }

  explainWorldEntryActivation(worldId, entryId, label = null) {
    const id = String(worldId || '').trim();
    const targetEntryId = String(entryId || '').trim();
    if (!id || !targetEntryId) return null;
    const data = this.worldStore.load(id);
    if (!data || typeof data !== 'object') return null;

    const labelObj = (label && typeof label === 'object') ? label : this.buildWorldDebugLabel();
    const matchContext =
      labelObj && typeof labelObj.matchContext === 'object' && labelObj.matchContext
        ? labelObj.matchContext
        : null;
    const matchText = String(labelObj?.matchText || '');
    const worldSettings = this.getWorldGlobalSettings?.() || this.worldGlobalSettings || {};
    const {
      globalCaseSensitive,
      globalMatchWholeWords,
      globalRecursiveScan,
      globalUseGroupScoring,
      minActivations,
      maxDepthSetting,
      maxRecursionStepsSetting,
    } = buildWorldActivationSettings(worldSettings);
    const baseEntries = prepareWorldEntries({
      worldId: id,
      data,
      loadWorld: (sourceId) => this.worldStore.load(sourceId),
    });
    if (!baseEntries.length) return null;

    const activation = analyzeWorldEntryActivation({
      baseEntries,
      matchText,
      matchContext,
      settings: {
        globalCaseSensitive,
        globalMatchWholeWords,
        globalRecursiveScan,
        globalUseGroupScoring,
        minActivations,
        maxDepthSetting,
        maxRecursionStepsSetting,
      },
      targetEntryId,
      applyProbability: false,
      evaluateEntryWhen: (when) => {
        if (!when || typeof when !== 'object' || isTrivialConditionTree(when)) {
          return { configured: false, passed: true, explanation: null };
        }
        const runtimeSessionId = String(matchContext?.sessionId || this.activeSessionId || '').trim();
        if (this.isVariableRuntimeEnabled?.(runtimeSessionId) === false) {
          return {
            configured: true,
            passed: false,
            explanation: { runtimeResult: false, reason: 'variable_runtime_disabled' },
          };
        }
        const explanation = explainConditionTree(
          when,
          this.buildWorldConditionRuntimeContext(runtimeSessionId),
        );
        return {
          configured: true,
          passed: explanation?.runtimeResult === true,
          explanation,
        };
      },
    });
    const targetEntry = activation.targetEntry;
    if (!targetEntry) return null;
    const directExplain = activation.directExplain;
    const active = activation.activeEntries.some((entry) => String(entry?._entryId || '') === targetEntryId);
    const sourceInfo = activation.activationMeta.get(targetEntryId) || { source: 'inactive', recursionStep: null };
    const selectiveLogicValue = Number.isFinite(Number(targetEntry?.selectiveLogic)) ? Math.trunc(Number(targetEntry.selectiveLogic)) : 0;
    const selectiveLogicLabelMap = {
      0: '任一副关键词命中',
      1: '并非全部命中',
      2: '全部不命中',
      3: '全部命中',
    };
    const content = String(targetEntry?.content || '').trim();
    const blockHasContent = Array.isArray(targetEntry?.promptBlocks)
      ? targetEntry.promptBlocks.some(block => String(block?.content || '').trim().length > 0)
      : false;
    const effectiveMatchContext = activation.effectiveMatchContext;
    const sourceFields = [];
    if (String(effectiveMatchContext?.userMessage || '').trim()) sourceFields.push('用户输入');
    if (Array.isArray(effectiveMatchContext?.history) && effectiveMatchContext.history.some(line => String(line || '').trim())) sourceFields.push('聊天历史');
    if (Array.isArray(effectiveMatchContext?.groupMemberNames) && effectiveMatchContext.groupMemberNames.some(name => String(name || '').trim())) sourceFields.push('群成员');
    if (targetEntry?.matchPersonaDescription && String(effectiveMatchContext?.personaText || '').trim()) sourceFields.push('Persona 描述');
    if (targetEntry?.matchCharacterDescription && String(effectiveMatchContext?.character?.description || '').trim()) sourceFields.push('角色描述');
    if (targetEntry?.matchCharacterPersonality && String(effectiveMatchContext?.character?.personality || '').trim()) sourceFields.push('角色性格');
    if (targetEntry?.matchCharacterDepthPrompt && String(effectiveMatchContext?.character?.depthPrompt || '').trim()) sourceFields.push('角色深度提示');
    if (targetEntry?.matchScenario && String(effectiveMatchContext?.character?.scenario || '').trim()) sourceFields.push('场景');
    if (targetEntry?.matchCreatorNotes && String(effectiveMatchContext?.character?.creatorNotes || '').trim()) sourceFields.push('作者注释');
    const probabilityRaw = Number(targetEntry?.probability);
    const probabilityEnabled = targetEntry?.useProbability !== false && Number.isFinite(probabilityRaw) && probabilityRaw < 100;
    const filteredByGroup = activation.beforeGroupEntryIds.has(targetEntryId) && !active;
    const keys = normalizeWorldEntryKeys(targetEntry);
    const secondaryKeys = normalizeWorldEntrySecondaryKeys(targetEntry);
    const explanationSessionId = String(matchContext?.sessionId || this.activeSessionId || '').trim();
    const suggestionMemoryPlan = (
      explanationSessionId
      && String(this.lastMemoryPlan?.targetId || '').trim() === explanationSessionId
    ) ? this.lastMemoryPlan : null;
    const downgradeSuggestion = buildWorldbookDowngradeSuggestion({
      entry: {
        worldId: id,
        entryId: targetEntryId,
        title: String(targetEntry?.comment || targetEntry?.title || targetEntryId).trim() || targetEntryId,
        keys,
        constant: targetEntry?.constant === true,
        disabled: targetEntry?.disable === true,
      },
      memoryItems: [
        ...(Array.isArray(suggestionMemoryPlan?.items) ? suggestionMemoryPlan.items : []),
        ...(Array.isArray(suggestionMemoryPlan?.recallItems) ? suggestionMemoryPlan.recallItems : []),
      ],
    });
    return {
      entryId: targetEntryId,
      active,
      activationSource: active ? sourceInfo.source : 'inactive',
      recursionStep: active ? sourceInfo.recursionStep : null,
      directMatch: directExplain.passed,
      variableConditionConfigured: directExplain.variableConditionConfigured === true,
      variableConditionPassed: directExplain.variableConditionPassed !== false,
      variableConditionExplanation: directExplain.variableConditionExplanation || null,
      filteredByGroup,
      disabled: Boolean(targetEntry?.disable),
      constant: Boolean(targetEntry?.constant),
      probabilityEnabled,
      probabilityValue: Number.isFinite(probabilityRaw) ? Math.max(0, Math.min(100, probabilityRaw)) : 100,
      probabilitySimulated: false,
      recursiveEnabled: globalRecursiveScan,
      preventRecursion: Boolean(targetEntry?.preventRecursion),
      excludeRecursion: Boolean(targetEntry?.excludeRecursion),
      delayUntilRecursion: Number.isFinite(Number(targetEntry?.delayUntilRecursion))
        ? Math.max(0, Math.trunc(Number(targetEntry.delayUntilRecursion)))
        : 0,
      hasMatchInput: directExplain.hasMatchInput,
      hasContent: Boolean(content || blockHasContent),
      keys,
      secondaryKeys,
      matchedPrimaryKeys: directExplain.matchedPrimaryKeys,
      matchedSecondaryKeys: directExplain.matchedSecondaryKeys,
      selective: Boolean(targetEntry?.selective) && secondaryKeys.length > 0,
      selectiveLogic: selectiveLogicValue,
      selectiveLogicLabel: selectiveLogicLabelMap[selectiveLogicValue] || '自定义',
      reasons: directExplain.reasons,
      downgradeSuggestion,
      sourceFields,
      entryTextPreview: String(directExplain.entryText || '').slice(0, 240),
      groups: Array.isArray(targetEntry?._groups) ? targetEntry._groups : [],
    };
  }

  getTemplateRenderInjections({ sessionId, uiMode, content, userName, characterName, groupName, membersText } = {}) {
    const sid = String(sessionId || '').trim();
    const mode = String(uiMode || '').trim().toLowerCase() === 'rp' ? 'rp' : 'chat';
    const matchContext = {
      uiMode: mode,
      sessionId: sid,
      sessionName: String(groupName || characterName || '').trim(),
    };
    const matchText = String(content ?? '');
    const collectEntries = (worldId) => this.collectWorldEntries(worldId, { matchText, matchContext });
    const worldSettings = this.getWorldGlobalSettings?.() || this.worldGlobalSettings || {};
    const insertionStrategy = normalizeWorldInsertionStrategy(worldSettings.insertionStrategy, 'role_first');
    const resolvedWorldState = this.getResolvedWorldState(sid, { uiMode: mode });
    const globalEntries = [];
    resolvedWorldState.globalWorldIds.forEach((id) => {
      if (!id) return;
      globalEntries.push(...collectEntries(id));
    });
    const roleEntries = [];
    resolvedWorldState.roleWorldIds.forEach((id) => {
      if (!id) return;
      const entries = collectEntries(id);
      if (entries.length) roleEntries.push(...entries.map(entry => ({ ...entry, _src: 'role' })));
    });
    const sessionEntries = [];
    resolvedWorldState.sessionWorldIds.forEach((id) => {
      if (!id) return;
      const entries = collectEntries(id);
      if (entries.length) sessionEntries.push(...entries.map(entry => ({ ...entry, _src: 'session' })));
    });
    const mergedEntries = this.mergeWorldEntries(globalEntries, [...roleEntries, ...sessionEntries], insertionStrategy);
    const before = [];
    const after = [];
    const macroContext = {
      user: String(userName || '').trim(),
      char: String(characterName || '').trim(),
      group: String(groupName || '').trim() || String(characterName || '').trim(),
      members: String(membersText || '').trim(),
      uiMode: mode,
    };
    const formatContent = (entry) => {
      const raw = this.processTextMacros(String(entry?.content || ''), {
        ...macroContext,
        sessionId: sid,
      });
      const trimmed = String(raw || '').trim();
      if (!trimmed) return '';
      return this.regex.apply(trimmed, this.getRegexContext({ sessionId: sid, uiMode: mode }), regex_placement.WORLD_INFO, {
        isMarkdown: true,
        isPrompt: false,
        isEdit: false,
        depth: 0,
      });
    };
    mergedEntries.forEach((entry) => {
      const tags = parseTemplateInjectTags(entry?.comment || '');
      if (!tags.length) return;
      const text = formatContent(entry);
      if (!text) return;
      tags.forEach(tag => {
        if (tag.stage !== 'render' || tag.type !== 'edge') return;
        if (tag.mode === 'before') before.push(text);
        if (tag.mode === 'after') after.push(text);
      });
    });
    return { before, after };
  }

  mergeWorldEntriesDetailed(globalEntries = [], sessionEntries = [], strategy = 'role_first') {
    const sourceRank = (src) => {
      if (strategy === 'global_first') {
        if (src === 'global') return 0;
        if (src === 'role') return 1;
        return 2;
      }
      if (strategy === 'role_first') {
        if (src === 'role') return 0;
        if (src === 'session') return 1;
        return 2;
      }
      return 0;
    };
    const g = Array.isArray(globalEntries) ? globalEntries : [];
    const s = Array.isArray(sessionEntries) ? sessionEntries : [];
    const merged = [
      ...g.map((e, i) => ({ ...e, _src: String(e?._src || 'global').trim() || 'global', _srcSeq: i })),
      ...s.map((e, i) => ({ ...e, _src: String(e?._src || 'session').trim() || 'session', _srcSeq: i })),
    ];
    merged.sort((a, b) => {
      const oa = Number.isFinite(Number(a?.order)) ? Number(a.order) : 0;
      const ob = Number.isFinite(Number(b?.order)) ? Number(b.order) : 0;
      if (oa !== ob) return oa - ob;
      const sr = sourceRank(a._src) - sourceRank(b._src);
      if (sr !== 0) return sr;
      const sa = Number.isFinite(Number(a?._srcSeq)) ? Number(a._srcSeq) : 0;
      const sb = Number.isFinite(Number(b?._srcSeq)) ? Number(b._srcSeq) : 0;
      return sa - sb;
    });
    const seen = new Set();
    const deduped = merged.filter((entry) => {
      const sourceId = String(entry?._sourceWorldId || '').trim();
      const dedupeKey = String(entry?._dedupeKey || entry?._entryId || '').trim();
      if (!sourceId || !dedupeKey) return true;
      const key = `${sourceId}::${dedupeKey}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const budgetTokens = this.getWorldBudgetTokens?.();
    if (!Number.isFinite(Number(budgetTokens))) {
      return {
        entries: deduped,
        trimmedEntries: [],
        budgetTokens: null,
        usedTokens: deduped.reduce(
          (sum, entry) => sum + estimateTokens(
            String(entry?.content || ''),
            this.activeTokenEstimateMode || 'rough',
          ),
          0,
        ),
        overflowed: false,
      };
    }
    if (Number(budgetTokens) <= 0) {
      if (deduped.length) {
        const settings = this.getWorldGlobalSettings?.() || this.worldGlobalSettings || {};
        if (settings.alertOnOverflow === true) this.warnWorldBudgetOverflow?.();
      }
      return {
        entries: [],
        trimmedEntries: deduped,
        budgetTokens: 0,
        usedTokens: 0,
        overflowed: deduped.length > 0,
      };
    }
    let used = 0;
    let overflowed = false;
    const trimmedEntries = [];
    const filtered = deduped.filter((entry) => {
      const cost = estimateTokens(
        String(entry?.content || ''),
        this.activeTokenEstimateMode || 'rough',
      );
      if (used + cost > budgetTokens) {
        overflowed = true;
        trimmedEntries.push(entry);
        return false;
      }
      used += cost;
      return true;
    });
    if (overflowed) {
      const settings = this.getWorldGlobalSettings?.() || this.worldGlobalSettings || {};
      if (settings.alertOnOverflow === true) {
        this.warnWorldBudgetOverflow?.();
      }
    }
    return {
      entries: filtered,
      trimmedEntries,
      budgetTokens: Number(budgetTokens),
      usedTokens: used,
      overflowed,
    };
  }

  mergeWorldEntries(globalEntries = [], sessionEntries = [], strategy = 'role_first') {
    return this.mergeWorldEntriesDetailed(globalEntries, sessionEntries, strategy).entries;
  }

  formatWorldPrompt(worldId, label) {
    const entries = this.collectWorldEntries(worldId, label);
    if (!entries.length) return '';
    return entries.map(e => e.content).join('\n\n');
  }

  /**
   * 生成当前世界书的提示串
   */
  getActiveWorldPrompt() {
    const worldSettings = this.getWorldGlobalSettings?.() || this.worldGlobalSettings || {};
    const insertionStrategy = normalizeWorldInsertionStrategy(worldSettings.insertionStrategy, 'role_first');
    const resolvedWorldState = this.getResolvedWorldState(this.activeSessionId);
    const collectEntries = worldId => this.collectWorldEntries(worldId, { matchText: '' });
    const syspResolved = this.presets.getResolvedActive('sysprompt', {
      sessionId: this.activeSessionId,
      uiMode: String(this.activeSessionId || '').trim().startsWith('rp:') ? 'rp' : 'chat',
    }) || null;
    const syspBase = syspResolved?.preset || null;
    const syspResolver = this.debugUiRegistry?.actions?.resolveAgentSyspromptPresetSync;
    let syspActive = syspBase;
    if (typeof syspResolver === 'function' && syspBase) {
      try {
        syspActive = syspResolver({
          presetId: String(syspResolved?.presetId || '').trim(),
          preset: syspBase,
          sessionId: this.activeSessionId,
          uiMode: String(this.activeSessionId || '').trim().startsWith('rp:') ? 'rp' : 'chat',
        }) || syspBase;
      } catch {
        syspActive = syspBase;
      }
    }
    const builtinEntries = this.buildPhoneFormatPromptEntries(syspActive, {
      momentCreateRules: syspActive?.moment_create_enabled && syspActive?.phone_format_moment_enabled !== false
        ? String(syspActive?.moment_create_rules || '')
        : '',
      momentMediaMode: appSettings.get().autoImagePromptMomentMediaMode,
      autoImagePromptEnabled: appSettings.get().autoImagePromptEnabled === true,
    });
    const builtinPart = builtinEntries.map(e => e.content).join('\n\n');
    const globalEntries = [];
    resolvedWorldState.globalWorldIds.forEach((id) => {
      if (!id) return;
      globalEntries.push(...collectEntries(id));
    });
    const roleEntries = [];
    resolvedWorldState.roleWorldIds.forEach((id) => {
      if (!id) return;
      const list = collectEntries(id);
      if (list.length) roleEntries.push(...list.map(entry => ({ ...entry, _src: 'role' })));
    });
    const sessionEntries = [];
    resolvedWorldState.sessionWorldIds.forEach((id) => {
      if (!id) return;
      const list = collectEntries(id);
      if (list.length) sessionEntries.push(...list.map(entry => ({ ...entry, _src: 'session' })));
    });
    const mergedContent = this.mergeWorldEntries(globalEntries, [...roleEntries, ...sessionEntries], insertionStrategy)
      .map(e => e.content)
      .join('\n\n');
    return [builtinPart, mergedContent].filter(Boolean).join('\n\n');
  }

  getWorldForSession(sessionId = this.activeSessionId) {
    const val = this.worldSessionMap[sessionId];
    const list = this.normalizeWorldIds(val);
    return list[0] || null;
  }
}

// 创建全局实例
window.appBridge = new AppBridge();

// SillyTavern compatibility entry. App-native slash commands are handled by
// command-runner from the composer; triggerSlash is kept as a card/script API.
window.triggerSlash = createSillyTavernSlashCompat({
  appBridge: window.appBridge,
  getChatUI,
  getChatStore: bridge => bridge?.getChatStore?.(),
  logger,
  getWindow: () => window,
  getDocument: () => document,
  getToastr: () => window.toastr,
});

window.getWorldInfoSettings = async () => {
  return await window.appBridge.getWorldInfo();
};

window.saveWorldInfo = async data => {
  await window.appBridge.saveWorldInfo(window.appBridge.getCurrentCharacterId?.() || '', data);
};

// 兼容：从 ST world JSON 导入（期望前端读取后调用）
window.importSTWorld = async (jsonObj, name = 'imported', options = {}) => {
  const simplified = convertSTWorld(jsonObj, name);
  const snapshot = await window.appBridge.getWorldInfoSnapshot(name);
  const importPlan = buildWorldbookImportPlan({
    worldId: name,
    incomingWorld: simplified,
    snapshot,
  });
  const conflictAction = String(options?.conflictAction || '').trim();
  if (importPlan.conflict && conflictAction !== WORLDBOOK_IMPORT_DECISIONS.overwrite) {
    const error = new Error(`同名世界书「${importPlan.targetId}」已存在，需要明确确认后才能覆盖。`);
    error.code = WORLDBOOK_IMPORT_CONFLICT_CODE;
    error.details = importPlan.conflict;
    throw error;
  }
  await window.appBridge.saveWorldInfo(
    importPlan.targetId,
    importPlan.incomingWorld,
    importPlan.saveOptions,
  );
  return simplified;
};

// 初始化
window.appBridge
  .init()
  .then(() => {
    logger.debug('App Bridge 初始化完成');
  })
  .catch(error => {
    logger.error('❌ App Bridge 初始化失败:', error);
  });

export { AppBridge };
