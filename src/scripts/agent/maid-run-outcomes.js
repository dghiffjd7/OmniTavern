// 检索 → 执行 → 自动验证 → 最终结果 → 用户反馈的关联（Agent 能力注册计划 Phase B）。
// candidateHit 只说明模型选中的能力在候选里（召回），不代表工具做成了；这里按每个动作步骤记下真正的结果：
// 写入后由自动验证读回确认的算「已验证」，验证没通过的单列；用户在确认时拒绝、或取消整个任务的也单列。
// 只用于诊断与之后的改进，不参与排序或自动调整。

const trim = value => String(value ?? '').trim();
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const DENIED_CODES = new Set(['permission_denied', 'safety_denied']);
export const MAID_OUTCOME_LIMIT = 40;

const isDenied = (step) => {
  if (DENIED_CODES.has(trim(step?.failureCode))) return true;
  const reason = `${trim(step?.output?.reason)} ${trim(step?.output?.errorCode)}`;
  return trim(step?.status) === 'skipped' && /(?:denied|declined)/i.test(reason);
};

/**
 * steps：maid runPrompt 结果里的步骤（toolName、status、metadata.verificationFor、candidateSnapshotId、candidateHit、failureCode）。
 * 返回每个动作步骤一条：{ toolName, candidateSnapshotId, candidateHit, outcome, verification }。
 * outcome：verified／verification_failed／succeeded／failed／denied／cancelled；verification：verified／failed／none。
 */
export const buildMaidStepOutcomes = (steps = [], { runStatus = '' } = {}) => {
  const list = Array.isArray(steps) ? steps.filter(isPlainObject) : [];
  const runCancelled = trim(runStatus) === 'cancelled';
  const outcomes = [];
  list.forEach((step, index) => {
    const toolName = trim(step.toolName);
    if (!toolName || trim(step.metadata?.verificationFor)) return;
    const check = list.slice(index + 1).find(next => trim(next?.metadata?.verificationFor) === toolName);
    const verification = !check ? 'none' : trim(check.status) === 'succeeded' ? 'verified' : 'failed';
    const status = trim(step.status);
    let outcome;
    if (isDenied(step)) outcome = 'denied';
    else if (status === 'cancelled' || (runCancelled && status !== 'succeeded')) outcome = 'cancelled';
    else if (status !== 'succeeded') outcome = 'failed';
    else outcome = verification === 'verified' ? 'verified' : verification === 'failed' ? 'verification_failed' : 'succeeded';
    outcomes.push({
      toolName,
      candidateSnapshotId: trim(step.candidateSnapshotId),
      candidateHit: typeof step.candidateHit === 'boolean' ? step.candidateHit : null,
      outcome,
      verification,
    });
  });
  return outcomes.slice(-MAID_OUTCOME_LIMIT);
};

const emptyTally = () => ({ executions: 0, verified: 0, verificationFailed: 0, succeeded: 0, failed: 0, denied: 0, cancelled: 0 });
const KEY_BY_OUTCOME = { verified: 'verified', verification_failed: 'verificationFailed', succeeded: 'succeeded', failed: 'failed', denied: 'denied', cancelled: 'cancelled' };

/** 按工具汇总运行记录里的 metadata.outcomes（只读画像）。 */
export const summarizeMaidToolOutcomes = (runs = []) => {
  const overall = emptyTally();
  const byTool = new Map();
  (Array.isArray(runs) ? runs : []).forEach((run) => {
    const outcomes = Array.isArray(run?.metadata?.outcomes) ? run.metadata.outcomes : (Array.isArray(run?.outcomes) ? run.outcomes : []);
    outcomes.forEach((item) => {
      const key = KEY_BY_OUTCOME[trim(item?.outcome)];
      const toolName = trim(item?.toolName);
      if (!key || !toolName) return;
      if (!byTool.has(toolName)) byTool.set(toolName, { toolName, ...emptyTally() });
      [overall, byTool.get(toolName)].forEach((tally) => { tally.executions += 1; tally[key] += 1; });
    });
  });
  return {
    overall,
    // 出问题多的在前（验证没通过、失败、被拒绝），其次按次数
    byTool: [...byTool.values()].sort((a, b) => (b.verificationFailed + b.failed + b.denied) - (a.verificationFailed + a.failed + a.denied) || b.executions - a.executions),
  };
};
