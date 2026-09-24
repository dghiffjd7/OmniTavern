/* 删除类操作的“先预览、再确认”：女仆用 preview:true 调用删除工具得到待删清单时，本轮结束为“待确认”，
   把已解析的目标 id、作用域与参数冻结在 run 上；用户下一句明确确认就执行这份清单（APP 的确认弹窗照常出现），
   明确取消就作废；说了别的事则视为放弃，避免之后一句“确认”误执行旧清单。
   这条路径由上一轮已通过意图校验的预览产生，所以确认时不再要求当前这句话重复“删除”二字。 */

export const MAID_PENDING_ACTION_KIND = 'maid_pending_action';
export const MAID_PENDING_ACTION_TTL_MS = 30 * 60 * 1000;

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value ?? null));
const DELETE_TARGET_KEYS = { 'regex.delete_many': 'targets', 'preset.delete_many': 'presets', 'script.delete_many': 'scripts' };
const isPreviewableDeleteTool = toolName => Boolean(DELETE_TARGET_KEYS[trim(toolName)]);
const plannedCountOf = output => {
  const value = Number(output?.plannedCount ?? (Array.isArray(output?.items) ? output.items.length : 0));
  return Number.isFinite(value) ? value : 0;
};

// 本轮最后一次删除预览，且之后没有按同一工具真正执行过
export const buildMaidPendingActionFromSteps = (steps = [], { now = Date.now(), context = {} } = {}) => {
  const list = Array.isArray(steps) ? steps : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const step = list[index];
    const toolName = trim(step?.toolName);
    if (!isPreviewableDeleteTool(toolName)) continue;
    if (step?.args?.preview !== true) return null; // 最近一次删除已真正执行（或失败），不是待确认状态
    if (step?.status !== 'succeeded' || plannedCountOf(step?.output) <= 0) return null;
    const planned = (Array.isArray(step.output?.items) ? step.output.items : []).filter(item => item?.status === 'planned');
    // 未解析出稳定 id 的旧结果不能作为可执行快照，缺失/受保护项目也不能被下一轮重新纳入。
    if (!planned.length || planned.some(item => !trim(item.id))) return null;
    const targets = planned.map(item => Object.fromEntries(
      ['id', 'type', 'containerKey', 'scope', 'scopeId'].filter(key => item[key] !== undefined).map(key => [key, trim(item[key])]),
    ));
    const args = { ...clone(step.args), [DELETE_TARGET_KEYS[toolName]]: targets.map(item => item.id) };
    delete args.preview;
    const items = planned
      .slice(0, 20)
      .map(item => trim(item?.name || item?.label || item?.target || item?.id))
      .filter(Boolean);
    return {
      kind: MAID_PENDING_ACTION_KIND,
      version: 2,
      state: 'pending',
      toolName,
      featureId: trim(step.featureId, toolName),
      title: trim(step.title, toolName),
      args,
      items,
      targets,
      context: { sessionId: trim(step.output?.sessionId || context.sessionId), uiMode: trim(context.uiMode) },
      plannedCount: targets.length,
      createdAt: Number(now) || Date.now(),
      expiresAt: (Number(now) || Date.now()) + MAID_PENDING_ACTION_TTL_MS,
    };
  }
  return null;
};

// 语音中的确认/取消只作用于本通话；指明了所属任务（结构化确认）时只作用于该任务的待确认清单。
// 各类待确认工作流（删除清单、导入角色卡建房清单）共用这一规则。
export const isPendingRunInContext = (run = {}, context = {}) => {
  const callId = trim(context?.voiceCallId);
  const runCallId = trim(run?.metadata?.voiceCallId);
  const submissionId = trim(context?.pendingActionSubmissionId);
  if (submissionId && trim(run?.metadata?.submissionId) !== submissionId) return false;
  // 普通文本的裸确认不接续旧通话；只有显式选定任务时才允许跨模式续接。
  return callId ? runCallId === callId : !runCallId || Boolean(submissionId);
};

export const resolvePendingMaidAction = (runs = [], { now = Date.now(), context = {} } = {}) => {
  for (const run of Array.isArray(runs) ? runs : []) {
    const pending = run?.metadata?.pendingWorkflow;
    if (!isPlainObject(pending) || pending.kind !== MAID_PENDING_ACTION_KIND) continue;
    if (pending.state !== 'pending' || trim(run?.status) !== 'waiting_permission') continue;
    if (!(Number(pending.expiresAt) > Number(now))) continue;
    if (!trim(pending.toolName) || !isPlainObject(pending.args)) continue;
    if (!isPendingRunInContext(run, context)) continue;
    return { runId: trim(run?.id), snapshot: clone(pending) };
  }
  return null;
};

// 语音取消可在任务队列已释放后到达，直接关闭对应 run，不能再靠取消队列中的 submission。
export const cancelPendingMaidAction = (runtime, { submissionId = '', voiceCallId = '' } = {}) => {
  if (!trim(submissionId) || !trim(voiceCallId) || typeof runtime?.finishRun !== 'function') return false;
  const pending = resolvePendingMaidAction(runtime.listRuns?.({ kind: 'maid_assistant', limit: 100 }) || [], {
    context: { voiceCallId, pendingActionSubmissionId: submissionId },
  });
  if (!pending) return false;
  runtime.finishRun(pending.runId, {
    status: 'cancelled', summary: '用户取消了待确认的删除清单。', cancelReason: 'user_cancelled_pending_action',
    metadata: { maidStatus: 'cancelled', pendingWorkflow: { ...pending.snapshot, state: 'cancelled', closedAt: Date.now() } },
  });
  return true;
};

// 比一般“继续/好的”更严：只认简短、明确的确认或取消，其余一律当作新请求。
// 明确确认与语音协议一致（允许 / 允许一次 / allow / yes 等）；“好 / 可以 / ok”这类含糊回答在打字时算确认
// （之后仍有 APP 删除确认弹窗），语音中则返回 ambiguous：不执行也不作废，由女仆请用户明确说“允许”或“取消”。
const EXPLICIT_CONFIRM_PATTERNS = [
  /^(?:(?:我|嗯)\s*)?(?:允许|允許)(?:一次|执行|執行)?[\s。.!！~～吧的了呀啦]*$/iu,
  /^(?:yes|allow|allow it|allow once|yes,?\s*allow(?: it)?)[\s。.!！~～]*$/iu,
  /^(?:同意|确认|確認|执行|執行|删吧|刪吧|删除吧|刪除吧|确定|確定)[\s。.!！~～吧的了呀啦]*$/iu,
  /^(?:我)?(?:确认|確認|确定|確定|同意)(?:后|後)?(?:执行|執行|删除|刪除|删|刪)(?:吧|了)?[\s。.!！~～]*$/iu,
];
const VAGUE_CONFIRM_PATTERN = /^(?:好(?:的)?|可以|行|是的?|对|對|没问题|沒問題|ok|okay|嗯)[\s。.!！~～吧的了呀啦]*$/iu;

// 快捷入口只识别完整的简短口令。其余原话由模型结合清单判断，不拆句或按关键词推断条件。
const PURE_CANCEL_REPLY = /^(?:还是|還是)?(?:取消|算了|不要了|不要删了?|不要刪了?|别删了?|別刪了?|不删了?|不刪了?|先不删了?|先不刪了?|先不了?|作废|作廢|停止)[\s。.!！~～吧了]*$/iu;

export const classifyMaidPendingActionReply = (input = '', { voice = false } = {}) => {
  const text = String(input ?? '').normalize('NFKC').trim();
  if (!text || text.length > 24) return 'none';
  if (EXPLICIT_CONFIRM_PATTERNS.some(pattern => pattern.test(text))) return 'confirm';
  if (PURE_CANCEL_REPLY.test(text)) return 'cancel';
  if (VAGUE_CONFIRM_PATTERN.test(text)) return voice ? 'ambiguous' : 'confirm';
  return 'none';
};

export const buildConfirmedPendingActionPlan = (pending = {}) => ({
  ok: true,
  action: 'tool',
  toolName: trim(pending.snapshot?.toolName),
  featureId: trim(pending.snapshot?.featureId, pending.snapshot?.toolName),
  title: trim(pending.snapshot?.title, '执行已确认的操作'),
  args: clone(pending.snapshot?.args || {}),
  response: '按你确认的清单执行。',
  source: 'confirmed_pending_action',
  metadata: { confirmedPendingActionRunId: trim(pending.runId), confirmedDelete: { toolName: trim(pending.snapshot?.toolName), targets: clone(pending.snapshot?.targets || []) } },
});
