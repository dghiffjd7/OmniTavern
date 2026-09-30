import { t } from '../i18n/index.js';
import { hasPositiveMaidDeleteIntent } from './maid-capability-concept-retriever.js';
import { classifyMaidPendingActionReply } from './maid-pending-action.js';

const trim = value => String(value ?? '').trim();
const list = value => Array.isArray(value) ? value : [];
const READ_TOOLS = new Set(['app.search_feature', 'app.read_feature_doc', 'session.list', 'app.read_resource']);
const outputOf = step => step?.output?.toolName && step.output.result && typeof step.output.result === 'object'
  ? step.output.result : step?.output || {};

const hasForeignIdentity = (step, context) => {
  const result = outputOf(step);
  const sources = [step, step?.context, step?.metadata, result, result?.context];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of ['roleCardId', 'requestRoleCardId', 'scopeId']) {
      const actual = trim(source[key]);
      const expected = key === 'scopeId' ? trim(context.scopeId || context.roleCardId) : trim(context.roleCardId);
      if (actual && actual !== expected) return true;
    }
    for (const key of ['submissionId', 'runId', 'capabilityRequestId']) {
      const actual = trim(source[key]), expected = trim(context[key]);
      if (actual && expected && actual !== expected) return true;
    }
  }
  return false;
};

// The caller supplies this request's trusted observations and identity. Existing
// session read results do not attest their store scope: record the request scope,
// reject explicit mismatches, and never claim that each read's scope was verified.
// Observed IDs are evidence of reads, not a deletion selection or permission.
export const buildMaidSessionDeletionNotice = ({ input = '', context = {}, steps = [], decision = {} } = {}) => {
  const requestRoleCardId = trim(context.roleCardId);
  const requestRunId = trim(context.submissionId || context.runId || context.capabilityRequestId);
  const observations = list(steps);
  if (!requestRoleCardId || !requestRunId || context.signal?.aborted || context.runContinuation
    || context.operationIntentPolicy?.mode !== 'write_allowed'
    || !hasPositiveMaidDeleteIntent(input)
    || String(input).split(/[，,。；;！？!?\n]/u).some(clause => classifyMaidPendingActionReply(clause) === 'cancel')
    || decision.ok !== true || !['final', 'clarify'].includes(trim(decision.action))
    || ['cancelled', 'failed', 'interrupted'].includes(trim(decision.status))
    || /cancel|abort|permission|denied|forbidden/iu.test(trim(decision.reason))
    || !observations.length) return null;

  let compared = false;
  const observed = new Set(), evidenceStepIndexes = [];
  for (const [index, step] of observations.entries()) {
    const toolName = trim(step?.toolName), result = outputOf(step);
    if (!READ_TOOLS.has(toolName) || step?.status !== 'succeeded' || result.ok === false
      || step?.output?.ok === false || hasForeignIdentity(step, context)) return null;
    if (toolName === 'app.read_resource' && (trim(step?.args?.resource) !== 'session' || result.resource !== 'session')) return null;
    if (['session.list', 'app.read_resource'].includes(toolName) && step.featureId === 'session.compare') compared = true;
    if (toolName !== 'app.read_resource' || result.ok !== true) continue;
    const sessions = list(result.sessions);
    // Incomplete or anonymous observations cannot establish a candidate scope.
    if (!sessions.length || sessions.some(session => !trim(session?.id) || !trim(session?.name))) return null;
    let added = false;
    for (const session of sessions) {
      const id = trim(session.id);
      if (!observed.has(id)) { observed.add(id); added = true; }
    }
    if (added) evidenceStepIndexes.push(index);
  }
  if (!compared || observed.size < 2 || observed.size > 100) return null;
  return {
    kind: 'session_deletion_risk',
    source: 'app',
    message: t('APP 操作提醒：删除选定的联系人或会话会一并丢失其聊天记录和内部归档，不会合并到保留对象。后续需要先明确准确目标，再由您在 APP 的真实确认中批准；本次没有执行删除。'),
    observedCandidateIds: [...observed],
    requestRoleCardId,
    requestRunId,
    evidenceStepIndexes,
  };
};
