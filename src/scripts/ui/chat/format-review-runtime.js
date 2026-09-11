import { t } from '../../i18n/index.js';
import { resolveFormatReviewAvailability } from './format-review-settings-utils.js';

const trim = value => String(value ?? '').trim();

// 原 app.js 的格式复核执行块：目标快照、候选预览、完成回调与取消共用一个入口。
export const createFormatReviewExecutor = ({
  findMessage, resolveTarget, getScope, getPlace, getGuide, buildOptions, createRevision,
  runPreview, onPreview, onRun, onQueued, onCompleted = () => {}, logger = console,
} = {}) => async ({ sessionId = '', messageId = '', signal = null, automatic = false } = {}) => {
  const sid = trim(sessionId), mid = trim(messageId);
  if (signal?.aborted) return { status: 'cancelled', reason: 'user_cancelled' };
  if (getPlace(sid) === 'writing' && !trim(getGuide(sid))) return { status: 'skipped', reason: 'format_guide_missing' };
  const message = findMessage(mid, sid);
  if (!message || message.role !== 'assistant') return { status: 'skipped', reason: 'message_missing' };
  const sourceContent = String(message.content || ''), scope = getScope(sid);
  const canCommit = () => {
    const current = findMessage(mid, sid);
    return Boolean(current) && !signal?.aborted && getScope(sid) === scope && String(current.content || '') === sourceContent;
  };
  // 模型与格式说明随这次检查冻结；异步读取原文后再确认目标仍有效。
  const base = buildOptions(sid);
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
  const payload = await completion;
  if (!canCommit()) return { status: 'cancelled', reason: 'target_changed' };
  if (payload?.failed === true || payload?.agentRun?.status === 'failed') return { status: 'failed', reason: 'review_failed', error: String(payload?.agentRun?.errorMessage || payload?.error || t('格式复核失败')) };
  return { status: 'succeeded', artifact: { kind: 'format_review', payload: {
    status: payload?.result?.modelReview?.status || payload?.result?.status || 'completed',
    hasCandidate: Boolean(payload?.result?.modelReview?.canRepair || payload?.result?.repairCandidate),
  } } };
};

// 默认流程及旧编排尚未放置复核房子时使用。显式房子（包括停用的房子）接管本轮。
export const createCreativeFormatReviewRuntime = ({
  getSettings, getGuide, getPlace, getScope, run, sessionAsyncWorkRuntime = null, logger = console,
} = {}) => {
  const pending = new Map();
  const afterReceive = ({ message, sessionId, suppressed = false, signal = null } = {}) => {
    if (suppressed || signal?.aborted || message?.role !== 'assistant' || !message.id || getPlace(sessionId) !== 'writing') return null;
    if (!resolveFormatReviewAvailability(getSettings(), { place: 'writing', hasFormatGuide: Boolean(trim(getGuide(sessionId))) }).enabled) return null;
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
