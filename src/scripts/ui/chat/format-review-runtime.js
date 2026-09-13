import { t } from '../../i18n/index.js';
import { allowsAgentInvocation } from '../../agent/agent-invocation.js';
import { resolveFormatReviewAvailability } from './format-review-settings-utils.js';

const trim = value => String(value ?? '').trim();

// 原 app.js 的格式复核执行块：目标快照、候选预览、完成回调与取消共用一个入口。
export const createFormatReviewExecutor = ({
  findMessage, resolveTarget, getScope, getPlace, getGuide, buildOptions, createRevision,
  runPreview, onPreview, onRun, onQueued, onCompleted = () => {}, getConfig, getCurrentSessionId, logger = console,
} = {}) => {
 const pending = new Map();
 const execute = async ({ sessionId = '', messageId = '', signal = null, automatic = false, configOverride = null } = {}) => {
  const sid = trim(sessionId), mid = trim(messageId);
  if (signal?.aborted) return { status: 'cancelled', reason: 'user_cancelled' };
  if (getConfig && !allowsAgentInvocation(configOverride || getConfig(sid), automatic ? 'auto' : 'manual')) return { status: 'skipped', reason: '此 Agent 尚未允许当前调用方式' };
  if (getPlace(sid) === 'writing' && !trim(configOverride?.formatGuide ?? getGuide(sid))) return { status: 'skipped', reason: 'format_guide_missing' };
  const message = findMessage(mid, sid);
  if (!message || message.role !== 'assistant') return { status: 'skipped', reason: 'message_missing' };
  const sourceContent = String(message.content || ''), scope = getScope(sid);
  const canCommit = () => {
    const current = findMessage(mid, sid);
    return Boolean(current) && (automatic || !getCurrentSessionId || getCurrentSessionId() === sid) && !signal?.aborted && (!getConfig || getConfig(sid)?.enabled === true) && getScope(sid) === scope && String(current.content || '') === sourceContent;
  };
  // 模型与格式说明随这次检查冻结；异步读取原文后再确认目标仍有效。
  const base = buildOptions(sid, configOverride);
  if (base.enabled === false || base?.modelReview?.enabled !== true || typeof base?.modelReview?.backgroundChat !== 'function') {
    return { status: 'skipped', reason: 'model_unavailable' };
  }
  const repairTarget = await resolveTarget(message, sid);
  if (!canCommit()) return { status: 'cancelled', reason: 'target_changed' };
  if (!repairTarget?.ok) return { status: 'skipped', reason: repairTarget?.reason || 'target_unavailable' };
  const options = {
    ...base,
    ...(automatic ? { manualTrigger: false } : {}),
    baseRevision: createRevision(), sourceSnapshot: repairTarget.sourceText,
    repairTarget: { ...repairTarget, sessionId: repairTarget.targetSessionId || sid },
    sourceMessageId: mid,
    modelReview: { ...base.modelReview, autoApplyRepair: false,
      requestOptions: { ...(base.modelReview.requestOptions || {}), ...(signal ? { signal } : {}) } },
  };
  let settle;
  const completion = new Promise(resolve => { settle = resolve; });
  const preview = runPreview({
    message: { ...message, rawOriginal: repairTarget.sourceText }, sessionId: sid, chatFormatGuardian: options,
    onChatFormatGuardianPreview: payload => { if (canCommit()) onPreview(payload); },
    onChatFormatGuardianRun: payload => {
      if (canCommit()) onRun(payload);
      else if (getScope(sid) === scope && payload?.agentRun && !['queued', 'running'].includes(payload.agentRun.status)) {
        onRun({ ...payload, agentRun: { ...payload.agentRun, status: 'cancelled', cancelReason: 'target_changed' } });
      }
    },
    onChatFormatGuardianModelReviewQueued: payload => { if (canCommit()) onQueued({ ...payload, quiet: automatic }); },
    onChatFormatGuardianModelReviewCompleted: payload => { onCompleted(sid, payload); settle(payload || {}); },
    logger,
  });
  if (!preview) return { status: 'skipped', reason: 'no_source' };
  if (!preview.modelReviewQueued) return { status: 'succeeded', reason: 'local_only', artifact: { kind: 'format_review', payload: { status: preview?.result?.status || '' } } };
  const cancelled = () => settle({ cancelled: true });
  signal?.addEventListener('abort', cancelled, { once: true });
  if (signal?.aborted) cancelled();
  const payload = await completion;
  signal?.removeEventListener('abort', cancelled);
  if (!canCommit()) return { status: 'cancelled', reason: 'target_changed' };
  if (payload?.failed === true || payload?.agentRun?.status === 'failed') return { status: 'failed', reason: 'review_failed', error: String(payload?.agentRun?.errorMessage || payload?.error || t('格式复核失败')) };
  return { status: 'succeeded', artifact: { kind: 'format_review', payload: {
    status: payload?.result?.modelReview?.status || payload?.result?.status || 'completed',
    hasCandidate: Boolean(payload?.result?.modelReview?.canRepair || payload?.result?.repairCandidate),
  } } };
 };
 const run = options => {
   const sid = trim(options?.sessionId), mid = trim(options?.messageId);
   const invocation = options?.automatic ? 'auto' : 'manual';
   if (options?.signal?.aborted) return Promise.resolve({ status: 'cancelled' });
   if (getConfig && !allowsAgentInvocation(options?.configOverride || getConfig(sid), invocation)) return Promise.resolve({ status: 'skipped', reason: '此 Agent 尚未允许当前调用方式' });
   const key = JSON.stringify([sid, getScope(sid), mid, findMessage(mid, sid)?.content]);
   if (pending.has(key)) return Promise.resolve({ status: 'skipped', reason: '此回复正在进行格式修复' });
   const controller = new AbortController(), cancel = () => controller.abort();
   options?.signal?.addEventListener('abort', cancel, { once: true });
   const timeout = setTimeout(cancel, 120000);
   const job = { controller, sid, automatic: options?.automatic === true, scope: getScope(sid) };
   pending.set(key, job);
   return execute({ ...options, signal: controller.signal }).finally(() => {
     clearTimeout(timeout); options?.signal?.removeEventListener('abort', cancel); pending.delete(key);
   });
 };
 run.reconcile = () => { for (const job of pending.values()) if ((getConfig && !getConfig(job.sid)?.enabled) || getScope(job.sid) !== job.scope || (!job.automatic && getCurrentSessionId && getCurrentSessionId() !== job.sid)) job.controller.abort(); };
 return run;
};

// 默认流程及旧编排尚未放置复核房子时使用。显式房子（包括停用的房子）接管本轮。
export const createCreativeFormatReviewRuntime = ({
  getSettings, getGuide, getPlace, getScope, run, sessionAsyncWorkRuntime = null, logger = console,
} = {}) => {
  const pending = new Map();
  const afterReceive = ({ message, sessionId, suppressed = false, signal = null } = {}) => {
    if (suppressed || signal?.aborted || message?.role !== 'assistant' || !message.id || getPlace(sessionId) !== 'writing') return null;
    if (!resolveFormatReviewAvailability(getSettings(sessionId), { place: 'writing', hasFormatGuide: Boolean(trim(getGuide(sessionId))) }).enabled) return null;
    const key = `${getScope(sessionId)}:${sessionId}:${message.id}`;
    if (pending.has(key)) return pending.get(key);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const lease = sessionAsyncWorkRuntime?.register?.({ sessionId, kind: 'format_review', cancel });
    const task = Promise.resolve().then(() => run({ sessionId, messageId: message.id, signal: controller.signal, automatic: true }))
      .catch(error => {
        if (!controller.signal.aborted) logger?.warn?.('creative format review failed', error);
        return { status: controller.signal.aborted ? 'cancelled' : 'failed', reason: 'review_failed' };
      }).finally(() => { pending.delete(key); lease?.settle?.(); signal?.removeEventListener('abort', cancel); });
    pending.set(key, task);
    return task;
  };
  return { afterReceive };
};
