import { resolveAgentTextTargetAsync, spliceAgentTextTarget } from './agent-text-target.js';
import { buildTextEditRequest, buildAgentNoteRequest, buildAgentReferenceContext } from './agent-request-builder.js';
import { normalizeFormatPatchModelResult } from '../ui/chat/format-patch-transaction-utils.js';
import { validateFormatRepairFunctionPayloads, extractFormatFunctionBlocks } from '../ui/chat/format-repair-side-effect-utils.js';
import { allowsAgentInvocation } from './agent-invocation.js';
import { captureAgentReferenceMessages } from './agent-reference-context.js';
import { agentToolContextKey, agentToolMessageIdentity, isAgentToolReply } from './agent-tool-targets.js';
import { agentRequestTimeoutMs } from './agent-generation-settings.js';

// Some models wrap otherwise valid JSON in one Markdown code fence. Accept
// that presentation wrapper only; the revision, exact lines and patch limits
// still go through the shared strict transaction validator.
export const normalizeTextEditModelResult = (raw, options) => {
  const text = typeof raw === 'string' ? raw : raw?.content || raw?.text || '';
  const fenced = String(text).trim().match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  return normalizeFormatPatchModelResult(fenced ? fenced[1] : text, options);
};

const protectedThoughts = text => String(text).match(/<\s*(think|thinking|analysis)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi) || [];
export const validateTextEditCandidate = (original, candidate) => {
  const functional = validateFormatRepairFunctionPayloads({ originalText: original, candidateText: candidate });
  if (!functional.ok || JSON.stringify(extractFormatFunctionBlocks(original).map(b => b.raw)) !== JSON.stringify(extractFormatFunctionBlocks(candidate).map(b => b.raw))) return { ok: false, message: '修改涉及功能区块，请调整任务要求或处理范围' };
  if (JSON.stringify(protectedThoughts(original)) !== JSON.stringify(protectedThoughts(candidate))) return { ok: false, message: '修改涉及思考区块，请缩小处理范围' };
  return { ok: true };
};
const aborted = () => Object.assign(new Error('任务已取消或目标已变化'), { name: 'AbortError' });
export const createTextEditRuntime = ({ getContext, getMessage, getMessages, getRaw, getConfig, getBodyRule,
  captureModel, request, review, commit, resolveReference = null, resolveTarget = resolveAgentTextTargetAsync, notify = () => {}, onChange = () => {}, now = Date.now } = {}) => {
  const jobs = new Map(), seen = new Map();
  let sequence = 0;
  const contextKey = context => JSON.stringify(context);
  // Loading a disk-backed rawOriginal populates its cache on the message. Compare that
  // source separately after loading; cache hydration is not a user edit.
  const identity = agentToolMessageIdentity;
  const emit = () => onChange(list());
  const list = () => [...jobs.values()].map(j => ({ id: j.id, agentId: j.agentId, title: j.config.title, sessionId: j.sessionId,
    invocation: j.invocation, outputMode: j.config.outputMode || 'edit', text: j.text || '', trace: j.trace || null, reference: j.reference || null, status: j.status, message: j.message || '', createdAt: j.createdAt, messageId: j.messageId, context: j.context }));
  const stillCurrent = job => !job.controller.signal.aborted && contextKey(getContext(job.sessionId)) === contextKey(job.context)
    && getConfig(job.agentId, job.sessionId)?.enabled === true
    && (job.expectedConfigVersion === undefined || getConfig(job.agentId, job.sessionId)?.updatedAt === job.expectedConfigVersion)
    && JSON.stringify(getConfig(job.agentId, job.sessionId)?.tools || null) === job.toolsRevision
    && contextKey(getContext()) === contextKey(job.context)
    && identity(getMessage(job.messageId, job.sessionId)) === job.identity;
  const setStatus = (job, status, message = '') => { job.status = status; job.message = message; emit(); };
  const run = async ({ agentId, sessionId, messageId, selection, force = false, invocation = '', signal, configOverride, bodyRuleOverride, targetSnapshot } = {}) => {
    const config = force && configOverride || getConfig(agentId, sessionId), message = getMessage(messageId, sessionId);
    if (!config || !isAgentToolReply(message)) return { status: 'skipped', reason: 'invalid_target' };
    if (!(invocation === 'test' ? config.enabled === true : allowsAgentInvocation(config, force ? 'manual' : 'auto'))) return { status: 'skipped', reason: 'disabled' };
    const context = getContext(sessionId), signature = identity(message);
    if (targetSnapshot && (targetSnapshot.messageId !== messageId || targetSnapshot.identity !== signature
      || agentToolContextKey(targetSnapshot.context) !== agentToolContextKey(context))) return { status: 'skipped', reason: '原文或配置已变化，请重新选择处理范围' };
    const key = JSON.stringify([agentId, context, messageId, signature]);
    if ([...jobs.values()].some(j => j.key === key && ['running', 'ready', 'reviewing'].includes(j.status))) return { status: 'skipped', reason: 'already_running' };
    if (!force && seen.has(key)) return { status: 'skipped', reason: 'duplicate' };
    seen.set(key, true); while (seen.size > 100) seen.delete(seen.keys().next().value);
    // Retain at most 30 candidates/statuses. Pending candidates never hold a send lock.
    while (jobs.size >= 30) {
      const oldest = [...jobs.values()].find(j => !['running', 'reviewing'].includes(j.status));
      if (!oldest) return { status: 'skipped', reason: 'busy' };
      jobs.delete(oldest.id);
    }
    const controller = new AbortController();
    const bodyRule = JSON.parse(JSON.stringify(bodyRuleOverride || getBodyRule(sessionId) || null));
    const history = getMessages(sessionId) || [];
    const historySnapshot = captureAgentReferenceMessages(history, config.context, { targetMessageId: messageId });
    const job = { id: `text-edit-run-${now()}-${++sequence}`, agentId, sessionId, messageId, config: JSON.parse(JSON.stringify(config)),
      context, expectedConfigVersion: targetSnapshot?.configUpdatedAt,
      toolsRevision: JSON.stringify(getConfig(agentId, sessionId)?.tools || null), invocation: invocation === 'test' ? 'test' : force ? 'manual' : 'auto', identity: signature, controller, status: 'running', createdAt: now(), key };
    jobs.set(job.id, job); emit();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timeout = setTimeout(cancel, agentRequestTimeoutMs(job.config, 120000));
    try {
      const model = await captureModel(job.config, sessionId);
      const source = await getRaw(message, sessionId);
      if (!stillCurrent(job)) throw aborted();
      if (targetSnapshot && source !== targetSnapshot.source) throw aborted();
      job.target = targetSnapshot?.target || await resolveTarget(source, job.config.target, { bodyRule, selection, message, context, readOnly: job.config.outputMode === 'note' });
      if (!job.target.ok) throw new Error(job.target.message);
      const referenceContext = resolveReference
        ? await resolveReference({ config: job.config.context, context, messages: historySnapshot, targetMessageId: messageId, signal: controller.signal })
        : buildAgentReferenceContext(historySnapshot, job.config.context, { targetMessageId: messageId });
      job.reference = referenceContext;
      job.request = (job.config.outputMode === 'note' ? buildAgentNoteRequest : buildTextEditRequest)({ config: job.config, target: job.target, referenceContext });
      if (!stillCurrent(job)) throw aborted();
      const raw = await request(job.request, model, controller.signal, sessionId, { config: job.config,
        canContinue: () => stillCurrent(job), onTrace: trace => { job.trace = trace; emit(); } });
      if (!stillCurrent(job) || await getRaw(getMessage(messageId, sessionId), sessionId) !== source) throw aborted();
      if (job.config.outputMode === 'note') {
        job.text = String(typeof raw === 'string' ? raw : raw?.content || raw?.text || '').trim().slice(0, 24000);
        setStatus(job, job.text ? 'ready' : 'unchanged');
        if (job.text) notify({ title: config.title, text: 'Agent 结果待查看', runId: job.id, sessionId });
        return { status: 'succeeded', artifact: { kind: 'agent_note', runId: job.id } };
      }
      const result = normalizeTextEditModelResult(raw, { originalText: job.target.text, baseRevision: job.request.baseRevision });
      if (!result.ok) throw new Error(result.validationErrors?.[0]?.message || '模型返回的修改无法验证');
      if (!result.canRepair) { setStatus(job, result.status === 'no_change' ? 'unchanged' : 'failed', result.repairSummary || '没有可应用的修改'); return { status: 'succeeded', reason: result.status }; }
      const validation = validateTextEditCandidate(source, spliceAgentTextTarget(job.target, result.candidateText));
      if (!validation.ok) throw new Error(validation.message);
      job.result = result; setStatus(job, 'ready', result.repairSummary);
      notify({ title: config.title, text: '修改建议待查看', runId: job.id, sessionId });
      return { status: 'succeeded', artifact: { kind: 'text_edit_candidate', runId: job.id } };
    } catch (error) {
      const cancelled = controller.signal.aborted || error.name === 'AbortError';
      setStatus(job, cancelled ? 'cancelled' : 'failed', error.message);
      return { status: cancelled ? 'cancelled' : 'failed', reason: error.message };
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
  };
  const open = async id => {
    const job = jobs.get(id); if (!job || job.status !== 'ready' || job.config.outputMode === 'note') return false;
    const fresh = async () => stillCurrent(job) && await getRaw(getMessage(job.messageId, job.sessionId), job.sessionId) === job.target.source;
    if (!await fresh()) { setStatus(job, 'expired', '原文或存档已变化，请重新运行'); return false; }
    setStatus(job, 'reviewing');
    try {
      const accepted = await review({ message: getMessage(job.messageId, job.sessionId), originalText: job.target.text,
        linePatches: job.result.linePatches, title: job.config.title, summary: job.result.repairSummary,
        validateCandidate: ({ candidateText }) => {
          try {
            const valid = validateTextEditCandidate(job.target.source, spliceAgentTextTarget(job.target, candidateText));
            return { canApply: stillCurrent(job) && valid.ok, statusText: valid.message || (stillCurrent(job) ? '仅替换选定范围' : '原文已变化，请重新运行') };
          } catch (error) { return { canApply: false, statusText: error.message }; }
        } });
      if (!accepted.confirmed) { setStatus(job, 'ready', job.result.repairSummary); return false; }
      if (!accepted.changed) { setStatus(job, 'ignored'); return false; }
      const text = spliceAgentTextTarget(job.target, accepted.candidateText);
      if (!await fresh() || !validateTextEditCandidate(job.target.source, text).ok) { setStatus(job, 'expired', '原文已变化，请重新运行'); return false; }
      // commit must recheck the frozen identity immediately before its write.
      const ok = await commit({ job, message: getMessage(job.messageId, job.sessionId), text, sourceSnapshot: job.target.source, canCommit: () => stillCurrent(job) });
      setStatus(job, ok ? 'applied' : 'expired', ok ? '' : '写回失败，请重新运行');
      return ok;
    } catch (error) { setStatus(job, 'failed', error.message); return false; }
  };
  return { run, open, list,
    reconcile: () => { for (const job of jobs.values()) if (!stillCurrent(job) && ['running', 'ready', 'reviewing'].includes(job.status)) { job.controller.abort(); setStatus(job, 'expired'); } },
    cancel: id => { const job = jobs.get(id); if (!job || ['applied', 'ignored'].includes(job.status)) return; job.controller.abort(); setStatus(job, 'cancelled'); },
    ignore: id => { const job = jobs.get(id); if (job) { job.controller.abort(); setStatus(job, 'ignored'); } },
    dispose: () => { jobs.forEach(j => j.controller.abort()); jobs.clear(); },
  };
};
