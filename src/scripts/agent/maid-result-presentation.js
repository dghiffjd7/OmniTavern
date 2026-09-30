import { resolveMaidWorldbookComparison } from './maid-worldbook-comparison.js';
import { buildMaidSessionDeletionNotice } from './maid-session-deletion-notice.js';
import { buildMaidWorldbookTargetClarification } from './maid-worldbook-target-clarification.js';

const trim = value => String(value ?? '').trim();
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const stopped = value => value?.ok === false || value?.aborted === true || value?.cancelled === true
  || value?.denied === true || value?.rejected === true
  || ['failed', 'cancelled', 'interrupted', 'waiting_permission', 'awaiting_confirmation', 'skipped'].includes(trim(value?.status))
  || /(?:^|_)(?:cancelled|canceled|aborted|denied|forbidden|rejected)(?:_|$)/u.test(trim(value?.reason));
const outputOf = step => object(step?.output?.result) ? step.output.result : step?.output;
const requestId = context => trim(context.submissionId || context.runId || context.capabilityRequestId);

const foreignIdentity = (source, context) => {
  if (!object(source)) return false;
  for (const key of ['roleCardId', 'requestRoleCardId']) {
    if (trim(source[key]) && trim(source[key]) !== trim(context.roleCardId)) return true;
  }
  // A resource's sessionId is a read target, not proof of a scope switch.
  // Only compare actual request identities supplied by the execution path.
  for (const key of ['submissionId', 'runId', 'capabilityRequestId', 'scopeId']) {
    if (Object.hasOwn(context, key) && Object.hasOwn(source, key)
      && trim(source[key]) !== trim(context[key])) return true;
  }
  return Boolean(source.runContinuation || trim(source.resumedFromRunId) || trim(source.crossRunSourceRunId));
};

const canPresent = (result, context, isWriteTool) => {
  if (!object(result) || result.appPresentation || result.ok !== true
    || !['succeeded', 'responded'].includes(trim(result.status)) || stopped(result)
    || result.pendingWorkflow || context.signal?.aborted || context.runContinuation
    || trim(context.resumedFromRunId) || trim(context.pendingActionSubmissionId)
    || !trim(context.roleCardId) || !requestId(context) || typeof isWriteTool !== 'function') return false;
  const decision = result.finalDecision;
  if (!object(decision) || stopped(decision) || !['final', 'clarify'].includes(trim(decision.action))
    || trim(decision.providerFcControl) && !['final', 'clarify'].includes(trim(decision.providerFcControl))) return false;
  if ([result, result.metadata, decision].some(source => foreignIdentity(source, context))) return false;
  if (!Array.isArray(result.steps) || !result.steps.length) return false;
  for (const step of result.steps) {
    const output = outputOf(step), toolName = trim(step?.toolName);
    if (!toolName || step.status !== 'succeeded' || !object(output)
      || stopped(step.output) || stopped(output) || step.output?.partial === true || output.partial === true
      || step.output?.localToolExecutionSkipped === true || output.localToolExecutionSkipped === true
      || output.worldbookSaved === true) return false;
    // Unknown tools fail closed. Callers must return the registry's actual
    // boolean capability, not infer reads from a missing write declaration.
    try { if (isWriteTool(toolName) !== false) return false; } catch { return false; }
    if ([step, step.context, step.metadata, output, output.context, output.scope].some(source => foreignIdentity(source, context))) return false;
    const observedCard = trim(output.targetSelectionEvidence?.currentCard?.personaId || output.currentCard?.personaId);
    if (observedCard && observedCard !== trim(context.roleCardId)) return false;
  }
  return true;
};

// Shared by FC and JSON final results. The model's decision remains diagnostic
// evidence; APP text is visibly attributed in message as well as in metadata,
// so existing message-only persistence cannot turn it into a model quotation.
export const applyMaidResultPresentation = (result, { input = '', context = {}, isWriteTool } = {}) => {
  if (!canPresent(result, context, isWriteTool)) return result;
  const modelMessage = typeof result.message === 'string' ? result.message : '';
  const attribution = {
    version: 1, source: 'app', modelMessage, modelSource: trim(result.source),
    requestRoleCardId: trim(context.roleCardId), requestRunId: requestId(context),
  };
  const clarification = buildMaidWorldbookTargetClarification({ input, context, steps: result.steps, decision: result.finalDecision });
  if (clarification?.source === 'app' && trim(clarification.message)) {
    return { ...result, message: clarification.message, appPresentation: { ...clarification, ...attribution } };
  }
  const comparison = resolveMaidWorldbookComparison({ input, context, steps: result.steps, maxMessageChars: 2200 });
  // Two background reads do not change the user's goal into lorebook merging.
  if (comparison?.autoPresentEligible === true && comparison.ok === true
    && ['ready', 'needs_selection', 'incomplete'].includes(comparison.status)
    && trim(comparison.message)) {
    return { ...result, message: comparison.message, appPresentation: {
      ...attribution, kind: 'worldbook_entries', status: comparison.status, reason: comparison.reason,
      report: comparison.report, ...(comparison.comparison ? { comparison: comparison.comparison } : {}),
    } };
  }
  const notice = buildMaidSessionDeletionNotice({ input, context, steps: result.steps, decision: result.finalDecision });
  if (notice?.source !== 'app' || !trim(notice.message)) return result;
  return { ...result, message: `${notice.message}${modelMessage ? `\n\n${modelMessage}` : ''}`, appPresentation: {
    ...notice, ...attribution, status: 'notice',
  } };
};
