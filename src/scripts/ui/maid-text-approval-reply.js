import { t } from '../i18n/index.js';

const trim = value => String(value ?? '').trim();
const normalized = value => trim(value).normalize('NFKC');
const SCOPE_KEYS = ['roleCardId', 'sessionId', 'uiMode'];
export const captureMaidTextApprovalScope = context => Object.fromEntries(
  SCOPE_KEYS.map(key => [key, trim(context?.[key])]),
);
export const sameMaidTextApprovalScope = (left, right) => Boolean(
  trim(left?.roleCardId) && trim(left?.uiMode)
  && SCOPE_KEYS.every(key => trim(left?.[key]) === trim(right?.[key])),
);

// Only complete, short replies grant permission. Any remaining condition is
// retained verbatim for replanning, never stripped from an initial "yes".
const CONFIRM = /^(?:确认|確認|确定|確定|同意|允许(?:一次)?|允許(?:一次)?|执行|執行|好(?:的)?|可以|行|没问题|沒問題|confirm|yes|allow(?: once)?|ok(?:ay)?)[\s。.!！~～]*$/iu;
const CANCEL = /^(?:不要(?:了)?|取消|算了|停止|先不了|不用了|不同意|不批准|不(?:要)?(?:执行|執行|创建|建立|建|做)(?:了)?|no|cancel|stop)[\s。.!！~～]*$/iu;
const REVISE = /^(?:(?:好(?:的)?|可以|确认|確認|同意|允许|允許|yes|ok(?:ay)?)[\s，,。.!！]*?(?:但(?:是)?|不过|不過|可是|除了|除外|只(?:要|限)?|改成|改为|改為|换成|換成)|(?:不对|不對|等等|等一下|修正|更正|改一下)[\s，,:：]|(?:把|将|將)?(?:这个群的?|這個群的?|群聊的?|群的?)?(?:名字|名称|名稱|群名|成员|成員)\s*(?:改(?:成|为|為|一下)?|换成|換成|加上|去掉|不要)|(?:actually|correction)\b)/iu;
const UNCERTAIN_REPLY = /^(?:(?:确认|確認|确定|確定|同意|允许|允許|好(?:的)?|可以|取消|不要|不同意|不批准)|(?:confirm|yes|allow|ok(?:ay)?|no|cancel)\b)/iu;

export const classifyMaidTextApprovalReply = input => {
  const text = normalized(input);
  if (!text) return 'none';
  if (text.length <= 32 && CANCEL.test(text)) return 'cancel';
  if (text.length <= 32 && CONFIRM.test(text)) return 'confirm';
  if (REVISE.test(text)) return 'revise';
  return UNCERTAIN_REPLY.test(text) ? 'unclear' : 'none';
};

const result = (reason, message, status = 'responded') => ({
  ok: true, responseType: 'local', status, reason, message,
});

// A revision is a new task. Preserve only task inputs, not permission, routing,
// continuation or executor state from the interrupted task or the new caller.
const revisionControls = (active, controls, scope, pending, input) => {
  const previous = active.controls?.context || {};
  const context = Object.fromEntries(['agentId', 'activePage', 'userSelection', 'maidSkillContext', 'maidSkillContextPrepared']
    .filter(key => previous[key] !== undefined).map(key => [key, previous[key]]));
  return {
    ...(trim(controls.id) ? { id: controls.id } : {}),
    ...(typeof controls.onStatus === 'function' ? { onStatus: controls.onStatus } : {}),
    ...(typeof controls.onAccepted === 'function' ? { onAccepted: controls.onAccepted } : {}),
    preserveDraft: controls.preserveDraft,
    useDraftSkills: false,
    context: { ...context, ...scope },
    maidTextApprovalRevision: { scope: { ...scope }, input,
      originalGoal: active.text, requestId: pending.id, runId: active.runId, submissionId: active.id },
  };
};
const mergeAttachments = (previous = [], next = []) => {
  const seen = new Set();
  return [...previous, ...next].filter(item => {
    const key = item?.id || item?.llmUrl || item?.url || item;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(item => ({ ...item }));
};

// This handles replies to the currently visible APP approval, not model
// proposals or other pending workflows. The queue owns execution and aborts.
export const createMaidTextApprovalReply = ({
  getActive = () => null, getAppContext = () => null, getPendingApproval = () => null,
  resolveBoundApproval = () => false, abortSubmission = () => false,
  maxAttachments = 4,
} = {}) => {
  let consumed = null;
  return {
    handle({ text = '', attachments = [], controls = {} } = {}) {
      if (controls.source === 'maid_realtime' || controls.voiceCallId || controls.voiceRequestId) return { handled: false };
      const kind = classifyMaidTextApprovalReply(text);
      if (kind === 'none') return { handled: false };
      const active = getActive();
      if (!active || active.id !== consumed?.submissionId) consumed = null;
      if (active?.controls?.source === 'maid_realtime' || active?.controls?.voiceCallId) return { handled: false };
      const scope = captureMaidTextApprovalScope(getAppContext());
      const pending = active?.id && active?.runId ? getPendingApproval(active.runId) : null;
      if (!pending) {
        if (consumed && sameMaidTextApprovalScope(consumed.scope, scope)
          && active?.id === consumed.submissionId
          && (kind === 'confirm' || kind === 'cancel' || normalized(text) === consumed.text)) {
          return { handled: true, result: result('approval_already_handled', t('这项确认已处理，没有重复执行。')) };
        }
        return { handled: false };
      }
      if (!pending.ambiguous && pending.toolName !== 'group.create') return { handled: false };
      // Missing/ambiguous/hidden bindings must not send a permission-like reply
      // to the model as a fresh task that could select a different old request.
      if (pending.ambiguous || pending.visible !== true || pending.toolName !== 'group.create'
        || trim(pending.runId) !== active.runId || trim(pending.binding?.submissionId) !== active.id
        || !sameMaidTextApprovalScope(pending.binding, scope)) {
        return { handled: true, result: result('approval_target_unavailable', t('当前确认的任务或页面已变化，请查看对应任务后再操作。')), preserveDraft: true };
      }
      const bound = { id: pending.id, runId: active.runId, binding: { submissionId: active.id, ...scope } };
      if (kind === 'unclear' || (attachments.length && kind !== 'revise')) {
        return { handled: true, result: result('approval_reply_unclear', t('按当前清单执行请回复“确认”；不执行请回复“取消”。需要修改时请说明改动。')), preserveDraft: true };
      }
      const revisedAttachments = kind === 'revise' ? mergeAttachments(active.attachments, attachments) : [];
      if (revisedAttachments.length > maxAttachments) {
        return { handled: true, result: result('approval_revision_attachment_limit', t('附件超过上限，请先减少附件再修改任务。')), preserveDraft: true };
      }
      if (resolveBoundApproval(bound, kind === 'confirm' ? 'allow_once' : 'deny') !== true) {
        return { handled: true, result: result('approval_target_unavailable', t('当前确认的任务或页面已变化，请查看对应任务后再操作。')), preserveDraft: true };
      }
      consumed = { scope, submissionId: active.id, text: normalized(text) };
      if (kind === 'confirm') return { handled: true, result: result('approval_allowed_once', t('已允许本次创建群聊。')) };
      // settle(deny) is synchronous. Abort before its promise resumes so the
      // old planner cannot retry or publish a result for obsolete arguments.
      if (abortSubmission(active.id) !== true) {
        return { handled: true, result: result('approval_revision_unavailable', t('原请求已撤销；任务状态已变化，请重新说明要执行的操作。')), preserveDraft: true };
      }
      if (kind === 'cancel') return { handled: true,
        result: result('approval_cancelled', t('已取消本次创建群聊。'), 'cancelled') };
      return { handled: true, revision: {
        text: `${active.text}\n\n${t('用户修正：')}${text}`,
        attachments: revisedAttachments,
        controls: revisionControls(active, controls, scope, pending, text),
      } };
    },
  };
};
