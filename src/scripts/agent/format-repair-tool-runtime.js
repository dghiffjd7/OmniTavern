import { allowsAgentInvocation } from './agent-invocation.js';
import { agentToolContextKey, agentToolMessageIdentity, formatToolTargetKey, isAgentToolReply } from './agent-tool-targets.js';
import { buildFormatRepairRequest } from './format-repair-request.js';
import { validateFormatRepairSelection } from './format-repair-selection.js';
import { normalizeTextEditModelResult } from './text-edit-runtime.js';
import { validateFormatRepairFunctionPayloads, buildFormatFunctionSideEffectPlan } from '../ui/chat/format-repair-side-effect-utils.js';
import { extractChatFormatEventDrafts } from '../ui/chat/chat-format-guardian-utils.js';
import { runChatFormatGuardianBackgroundChat, buildChatFormatGuardianRetryInstruction } from '../ui/chat/after-receive-dispatch-utils.js';

const clone = value => structuredClone(value);
const active = new Set(['running', 'ready', 'reviewing', 'applying']);
const abortError = () => Object.assign(new Error('回复或会话已变化，请重新选择'), { name: 'AbortError' });

export const validateFormatRepairToolCandidate = ({ request, candidateText, linePatches }) => {
  const scoped = validateFormatRepairSelection(request.source, request.selection, candidateText, linePatches);
  if (!scoped.ok) return scoped;
  const functions = validateFormatRepairFunctionPayloads({ originalText: request.source, candidateText: scoped.text,
    allowedTableRanges: request.selection.tableRanges });
  if (!functions.ok) return { ok: false, message: functions.violations[0]?.message || '修改越过了功能块边界' };
  if (request.options.repairTarget.sourceKind === 'social_turn_raw') {
    const parserOptions = { ...request.options, customFormatGuide: request.modelOptions.customFormatGuide };
    const before = extractChatFormatEventDrafts(request.source, parserOptions), after = extractChatFormatEventDrafts(scoped.text, parserOptions);
    const newIssues = [...(after.errors || []), ...(after.warnings || [])].filter(issue => ![...(before.errors || []), ...(before.warnings || [])].includes(issue));
    if (after.status !== 'ready' && (!request.selection.fragment && request.selection.checkType !== 'tableEdit' || newIssues.length || after.eventDrafts.length !== before.eventDrafts.length)) {
      return { ok: false, message: newIssues[0] || after.errors?.[0] || '修改后无法安全解析聊天格式' };
    }
  }
  const effects = buildFormatFunctionSideEffectPlan({ originalText: request.source, candidateText: scoped.text });
  return { ok: true, text: scoped.text, effects };
};

// Manual format repair shares the ordinary model options and commit transaction.
// Its candidate lifecycle is independent of the automatic reply guardian.
export const createFormatRepairToolRuntime = ({ getContext, getMessage, getConfig, resolveTarget, buildOptions,
  review, commit, onChange = () => {}, notify = () => {}, now = Date.now } = {}) => {
  const jobs = new Map(); let sequence = 0;
  const list = () => [...jobs.values()].map(job => ({ id: job.id, agentId: 'reply_check', title: job.config.repairProfileName || job.config.title,
    repairProfileId: job.config.repairProfileId, context: job.context, sessionId: job.context.sessionId, messageId: job.messageId,
    status: job.status, unread: job.unread === true, message: job.message || '', createdAt: job.createdAt, scopeLabel: job.scopeLabel }));
  const update = (job, status, message = '') => { job.status = status; job.unread = status === 'ready' || status === 'failed'; job.message = message; onChange(); };
  const current = job => !job.controller.signal.aborted && agentToolContextKey(getContext()) === agentToolContextKey(job.context)
    && getConfig(job.context)?.enabled === true && isAgentToolReply(getMessage(job.messageId, job.context.sessionId))
    && agentToolMessageIdentity(getMessage(job.messageId, job.context.sessionId)) === job.identity;
  const fresh = async job => current(job) && formatToolTargetKey(await resolveTarget(getMessage(job.messageId, job.context.sessionId), job.context)) === formatToolTargetKey(job.target) && current(job);
  const run = async ({ context = getContext(), messageId, config, targetSnapshot, signal } = {}) => {
    if (!allowsAgentInvocation(config, 'manual')) return { status: 'skipped', reason: '此 Agent 尚未允许手动调用' };
    if (!targetSnapshot?.formatTarget?.ok || !targetSnapshot.formatSelection?.ok) return { status: 'skipped', reason: '请先选择可修复的原文' };
    const message = getMessage(messageId, context.sessionId);
    if (!isAgentToolReply(message) || agentToolContextKey(context) !== agentToolContextKey(getContext())) return { status: 'skipped', reason: '回复已变化，请重新选择' };
    const key = JSON.stringify([agentToolContextKey(context), formatToolTargetKey(targetSnapshot.formatTarget)]);
    if ([...jobs.values()].some(job => job.key === key && active.has(job.status))) return { status: 'skipped', reason: '这份回复已有任务或待审阅结果，请先查看或放弃' };
    while (jobs.size >= 20) {
      const old = [...jobs.values()].find(job => !active.has(job.status));
      if (!old) return { status: 'skipped', reason: '请先处理待审阅结果' }; jobs.delete(old.id);
    }
    const controller = new AbortController(), cancel = () => controller.abort();
    const { repairProfiles: _library, ...effectiveConfig } = config;
    const job = { id: `format-tool-run-${now()}-${++sequence}`, config: clone(effectiveConfig), context: { ...context }, messageId,
      target: clone(targetSnapshot.formatTarget), identity: agentToolMessageIdentity(message), key, controller, createdAt: now(), status: 'running' };
    jobs.set(job.id, job); onChange();
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    const timeout = setTimeout(cancel, 120000);
    try {
      if (!await fresh(job)) throw abortError();
      const selection = targetSnapshot.formatSelection;
      const request = await buildFormatRepairRequest({ config: job.config, repairTarget: job.target, message,
        range: selection.fragment ? { start: selection.start, end: selection.end } : null,
        baseOptions: buildOptions(context.sessionId, job.config), signal: controller.signal });
      job.request = request;
      job.scopeLabel = selection.fragment ? '原文片段' : selection.checkType === 'tableEdit' ? `tableEdit · ${selection.count}` : '完整回复';
      if (request.modelOptions.enabled !== true || typeof request.modelOptions.backgroundChat !== 'function') throw new Error('此方案尚未选择可用模型');
      let messages = request.messages, result, validation;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!current(job)) throw abortError();
        const raw = await runChatFormatGuardianBackgroundChat(request.modelOptions.backgroundChat, messages,
          { ...request.modelOptions.requestOptions, signal: controller.signal }, { timeoutMs: request.modelOptions.timeoutMs });
        if (!await fresh(job)) throw abortError();
        result = normalizeTextEditModelResult(raw, { originalText: request.selection.text, baseRevision: request.baseRevision });
        validation = result.canRepair ? validateFormatRepairToolCandidate({ request, candidateText: result.candidateText, linePatches: result.linePatches }) : { ok: result.ok };
        if (result.ok && validation.ok) break;
        messages = [...request.messages, { role: 'user', content: buildChatFormatGuardianRetryInstruction({ raw, review: { ...result,
          validationErrors: [...(result.validationErrors || []), ...(validation.message ? [{ code: 'scope_validation', message: validation.message }] : [])] } }) }];
      }
      if (!result?.ok || !validation?.ok) throw new Error(validation?.message || result?.validationErrors?.[0]?.message || '模型返回的修改无法验证');
      if (!result.canRepair) {
        update(job, result.status === 'no_change' ? 'unchanged' : 'failed', result.repairSummary || '没有可应用的修改');
      } else { job.result = result; update(job, 'ready', result.repairSummary); }
      notify(job);
      return { status: 'succeeded', artifact: { kind: 'format_repair', runId: job.id } };
    } catch (error) {
      const cancelled = controller.signal.aborted || error.name === 'AbortError';
      if (job.status === 'running') update(job, cancelled ? 'cancelled' : 'failed', error.message);
      if (!cancelled) notify(job);
      return { status: cancelled ? 'cancelled' : 'failed', reason: error.message, artifact: { runId: job.id } };
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
  };
  const open = async id => {
    const job = jobs.get(id); if (job?.status !== 'ready') return false;
    if (!await fresh(job)) { update(job, 'expired', '原文或存档已变化，请重新选择'); return false; }
    update(job, 'reviewing', job.result.repairSummary);
    try {
      const accepted = await review({ message: getMessage(job.messageId, job.context.sessionId), originalText: job.request.selection.text,
        linePatches: job.result.linePatches, title: job.config.repairProfileName || '格式修复', wholeChange: true,
        summary: job.scopeLabel, validateCandidate: ({ candidateText, acceptedPatches }) => {
          const validation = validateFormatRepairToolCandidate({ request: job.request, candidateText, linePatches: acceptedPatches });
          const tables = validation.effects?.executeEntries.filter(entry => entry.kind === 'table_edit').length || 0;
          return { canApply: current(job) && validation.ok, statusText: !current(job) ? '原文已变化，请重新选择'
            : validation.message || (tables ? `应用后将处理 ${tables} 处表格指令` : '仅应用所选范围内的修改') };
        } });
      if (!accepted.confirmed) { update(job, current(job) ? 'ready' : 'expired', job.result.repairSummary); return false; }
      if (!accepted.changed) { update(job, 'ignored'); return false; }
      const validation = validateFormatRepairToolCandidate({ request: job.request, candidateText: accepted.candidateText, linePatches: accepted.acceptedPatches });
      if (!validation.ok || !await fresh(job)) { update(job, 'expired', validation.message || '原文已变化，请重新选择'); return false; }
      update(job, 'applying');
      const ok = await commit({ message: getMessage(job.messageId, job.context.sessionId), job, text: validation.text,
        selection: { ...job.request.selection, linePatches: accepted.acceptedPatches }, canCommit: () => current(job) });
      update(job, ok ? 'applied' : 'failed', ok ? '' : '应用未完成，请检查任务结果');
      if (ok) notify(job);
      return ok;
    } catch (error) { update(job, 'failed', error.message); notify(job); return false; }
  };
  return { run, open, list,
    reconcile: () => { for (const job of jobs.values()) if (active.has(job.status) && job.status !== 'applying' && !current(job)) { job.controller.abort(); update(job, 'expired', '回复或会话已变化'); } },
    cancel: id => { const job = jobs.get(id); if (job?.status === 'running') { job.controller.abort(); update(job, 'cancelled'); } },
    ignore: id => { const job = jobs.get(id); if (job && ['ready', 'failed', 'unchanged'].includes(job.status)) update(job, 'ignored'); },
    dispose: () => { jobs.forEach(job => job.controller.abort()); jobs.clear(); },
  };
};
