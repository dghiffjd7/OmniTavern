import { t } from '../i18n/index.js';

export const MAID_GROUP_PREVIEW_KIND = 'maid_group_preview';
export const MAID_GROUP_PREVIEW_TTL_MS = 30 * 60 * 1000;

export const isMaidGroupPreviewRequest = (input = '') => {
  const text = String(input ?? '').trim();
  const groupCreation = /(?:建群|(?:创建|建立|新建|建|开)[^，,。；;！？!?\n]{0,24}群|群聊[^，,。；;！？!?\n]{0,12}(?:创建|建立)|\b(?:create|build|start)\b[^.;!?\n]{0,40}\bgroup\b)/iu;
  const preview = /(?:先|只)\s*(?:(?:给我|給我|让我|讓我)\s*)?(?:预览|預覽)|(?:先|只)\s*(?:(?:给我|給我|让我|讓我)\s*)?(?:看(?:看|一下)?|列(?:出|个|個)?|展示|整理)[^，,。；;！？!?\n]{0,24}(?:清单|清單|方案|计划|計劃)|\bpreview\b[^.;!?\n]{0,40}\b(?:first|only)\b|\b(?:first|only)\b[^.;!?\n]{0,40}\bpreview\b/iu;
  const excluded = /^(?:怎么|怎麼|如何|怎样|怎樣|为什么|為什麼|什么是|什麼是|how\b|what\b)|(?:有什么作用|有什麼作用|是什么意思|是什麼意思)[？?\s]*$|(?:不要|别|別|不用|无需|無需|不必|不想|不打算|取消)\s*(?:先)?\s*(?:预览|預覽|看(?:看|一下)?(?:清单|清單|方案))|(?:^|[，,。；;！？!?\n])\s*(?:算了)?(?:不要了|取消|停止)[。.!！\s]*$/iu;
  return groupCreation.test(text) && preview.test(text) && !excluded.test(text);
};

const trim = value => String(value ?? '').trim();
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const STRING_SCOPE_KEYS = ['roleCardId', 'sessionId', 'uiMode', 'contactsScopeId', 'chatScopeId'];
const TOKEN_SCOPE_KEYS = ['contactsScopeToken', 'chatScopeToken'];
const SCOPE_KEYS = [...STRING_SCOPE_KEYS, ...TOKEN_SCOPE_KEYS];
const readScope = source => {
  if (!object(source) || !STRING_SCOPE_KEYS.every(key => Object.hasOwn(source, key) && typeof source[key] === 'string')
    || !TOKEN_SCOPE_KEYS.every(key => Number.isSafeInteger(source[key]) && source[key] >= 0)
    || !trim(source.roleCardId) || !trim(source.uiMode)) return null;
  return Object.fromEntries(SCOPE_KEYS.map(key => [key, source[key]]));
};
const sameScope = (left, right) => Boolean(left && right && SCOPE_KEYS.every(key => left[key] === right[key]));
const textContext = context => object(context) && !trim(context.voiceCallId) && !trim(context.voiceRequestId)
  && context.source !== 'maid_realtime' && !context.runContinuation && !trim(context.resumedFromRunId);
const validMembers = members => Array.isArray(members) && members.length >= 2 && members.length <= 50
  && members.every(member => object(member) && typeof member.id === 'string' && trim(member.id) === member.id
    && member.id && typeof member.name === 'string' && trim(member.name))
  && new Set(members.map(member => member.id)).size === members.length;
const validSnapshot = snapshot => object(snapshot) && snapshot.kind === MAID_GROUP_PREVIEW_KIND
  && snapshot.version === 1 && snapshot.state === 'pending' && snapshot.toolName === 'group.create'
  && typeof snapshot.name === 'string' && trim(snapshot.name) === snapshot.name && snapshot.name.length > 0 && snapshot.name.length <= 80
  && validMembers(snapshot.members) && typeof snapshot.open === 'boolean' && readScope(snapshot.scope)
  && trim(snapshot.origin?.runId) && trim(snapshot.origin?.submissionId)
  && Number.isFinite(snapshot.createdAt) && Number.isFinite(snapshot.expiresAt)
  && snapshot.expiresAt > snapshot.createdAt && snapshot.expiresAt - snapshot.createdAt <= MAID_GROUP_PREVIEW_TTL_MS;

// Only actual tool observations create a proposal. A model's final text cannot
// supply member identities, a scope, or an executable authorization.
export const buildMaidGroupPreviewFromSteps = (steps = [], { input = '', context = {}, now = Date.now() } = {}) => {
  const currentScope = readScope(context);
  if (!textContext(context) || !currentScope || !trim(context.runId) || !trim(context.submissionId) || !Number.isFinite(now)) return null;
  const list = Array.isArray(steps) ? steps : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const step = list[index];
    if (step?.toolName !== 'group.create') continue;
    const envelope = step.output;
    const output = object(envelope?.result) ? envelope.result : envelope;
    const preview = output?.groupPreview;
    // A later applied/failed group attempt supersedes earlier observations.
    if (step.status !== 'succeeded' || step.args?.preview !== true || !object(output)
      || envelope?.ok === false || envelope?.partial === true || output.ok !== true || output.preview !== true
      || output.partial === true || output.existingGroup || output.existing === true || output.created === true
      || trim(output.reason) || preview?.version !== 1 || !validMembers(preview.members)
      || typeof preview.name !== 'string' || preview.name !== trim(step.args.name) || preview.name !== output.name
      || !preview.name || preview.name.length > 80 || typeof preview.open !== 'boolean' || preview.open !== (step.args.open === true)
      || !sameScope(currentScope, readScope(preview.scope))) return null;
    const results = Array.isArray(output.results) ? output.results : [];
    const planned = results.filter(item => item?.status === 'planned');
    if (results.some(item => !['planned', 'skipped'].includes(item?.status))
      || results.some(item => item.status === 'skipped' && item.reason !== 'duplicate_member')
      || output.plannedCount !== preview.members.length || planned.length !== preview.members.length
      || !planned.every((item, memberIndex) => item.memberId === preview.members[memberIndex].id
        && item.name === preview.members[memberIndex].name && !trim(item.reason))) return null;
    return {
      kind: MAID_GROUP_PREVIEW_KIND, version: 1, state: 'pending', toolName: 'group.create', featureId: 'group.create',
      name: preview.name, members: preview.members.map(({ id, name }) => ({ id, name })), open: preview.open,
      scope: { ...currentScope }, origin: { runId: trim(context.runId), submissionId: trim(context.submissionId), stepIndex: index },
      input: trim(input), createdAt: now, expiresAt: now + MAID_GROUP_PREVIEW_TTL_MS,
    };
  }
  return null;
};

export const resolvePendingMaidGroupPreview = (runs = [], { context = {}, now = Date.now() } = {}) => {
  const currentScope = readScope(context);
  if (!textContext(context) || !currentScope || !trim(context.submissionId) || !Number.isFinite(now)) return null;
  const matches = [];
  for (const run of Array.isArray(runs) ? runs : []) {
    const snapshot = run?.metadata?.pendingWorkflow;
    if (!validSnapshot(snapshot) || run.status !== 'waiting_permission' || snapshot.expiresAt <= now || snapshot.createdAt > now
      || !textContext({ source: run.metadata?.submissionSource, voiceCallId: run.metadata?.voiceCallId, voiceRequestId: run.metadata?.voiceRequestId })
      || trim(run.id) !== snapshot.origin.runId || trim(run.metadata?.submissionId) !== snapshot.origin.submissionId
      || !sameScope(currentScope, readScope(snapshot.scope))
      || trim(context.pendingActionSubmissionId) && trim(context.pendingActionSubmissionId) !== snapshot.origin.submissionId
      || trim(context.pendingGroupPreviewRunId) && trim(context.pendingGroupPreviewRunId) !== run.id) continue;
    matches.push({ runId: run.id, snapshot: clone(snapshot) });
  }
  return matches.length === 1 ? matches[0] : null;
};

const CANCEL = /^(?:不要(?:了)?|取消|算了|停止|先不了|不用了|不(?:要)?(?:执行|執行|创建|建立|建|做)(?:了)?|no|cancel|stop)[\s。.!！~～]*$/iu;
const CONFIRM = /^(?:确认|確認|确定|確定|同意|允许(?:一次)?|允許(?:一次)?|执行|執行|好(?:的)?|可以|行|confirm|yes|allow(?: once)?|ok(?:ay)?)[\s。.!！~～]*$/iu;
const REVISION = /^(?:(?:好(?:的)?|可以|确认|確認|同意|允许|允許|yes|ok(?:ay)?)[\s，,。.!！]*(?:但(?:是)?|不过|不過|可是|除了|只(?:要|限)?|改成|改为|改為|换成|換成)|(?:把|将|將)?(?:这个群的?|這個群的?|群聊的?|群的?)?(?:名字|名称|名稱|群名|成员|成員)\s*(?:改|换|換|加|去掉|不要)|(?:actually|correction)\b)/iu;
const APPROVAL_LIKE = /^(?:(?:确认|確認|确定|確定|同意|允许|允許|好(?:的)?|可以|取消|不要)|(?:confirm|yes|allow|ok(?:ay)?|no|cancel)\b)/iu;
const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const classifyMaidGroupPreviewReply = (input = '', snapshot = {}) => {
  const text = trim(input);
  if (!text) return 'none';
  if (text.length <= 32 && CANCEL.test(text)) return 'cancel';
  if (text.length <= 32 && CONFIRM.test(text)) return 'confirm';
  if (REVISION.test(text)) return 'revise';
  const name = trim(snapshot.name);
  if (name && name.length <= 80) {
    const exactName = [name, `「${name}」`, `“${name}”`, `"${name}"`].map(escapePattern).join('|');
    const namedConfirmation = new RegExp(`^(?:确认|確認)[，,\\s]*(?:就)?按\\s*(?:${exactName})\\s*(?:这个名字|這個名字|这个名称|這個名稱)?\\s*(?:创建|建立|建)(?:群聊|群)?[\\s。.!！~～]*$`, 'u');
    if (namedConfirmation.test(text)) return 'confirm';
  }
  return APPROVAL_LIKE.test(text) ? 'unclear' : 'none';
};

// Confirmation selects the frozen proposal; the registry must still obtain
// the real APP approval. There is deliberately no permission in this plan.
export const buildConfirmedGroupPreviewPlan = (pending = {}) => {
  const snapshot = pending.snapshot;
  if (!validSnapshot(snapshot) || trim(pending.runId) !== snapshot.origin.runId) return null;
  return {
    ok: true, action: 'tool', toolName: 'group.create', featureId: 'group.create',
    title: t('按建群清单请求创建'), source: 'confirmed_group_preview',
    args: { name: snapshot.name, members: snapshot.members.map(member => member.id), open: snapshot.open },
    metadata: { confirmedGroupPreviewRunId: pending.runId },
  };
};

const singleLine = value => String(value).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/gu, ' ').trim();
const display = value => singleLine(value).replace(/[\\`*_{}\[\]<>()#!|~\-]/gu, '\\$&');

export const buildGroupCreationMessage = (output = {}) => {
  const result = output?.result || output;
  if (result?.ok !== true || result.verified !== true || !trim(result.group?.name)
    || !validMembers(result.group?.members)) return '';
  const values = { name: display(result.group.name), members: result.group.members.map(member => display(member.name)).join('、') };
  if (result.created === true) return t('已创建群聊「{name}」，成员：{members}。', values);
  if (result.existing === true) return t('群聊「{name}」已存在，已核对成员：{members}。', values);
  return '';
};

export const buildGroupPreviewMessage = (snapshot = {}) => {
  if (!validSnapshot(snapshot)) return '';
  const names = snapshot.members.map(member => singleLine(member.name));
  return [
    t('APP 建群预览：尚未创建群聊。'),
    t('群名：{name}', { name: display(snapshot.name) }),
    t('成员：\n{members}', { members: snapshot.members.map((member, index) => (
      names.filter(name => name === names[index]).length > 1
        ? `- ${t('同名成员：{name}（ID：{id}）', { name: display(member.name), id: display(member.id) })}`
        : `- ${display(member.name)}`
    )).join('\n') }),
    ...(snapshot.open ? [t('创建后打开群聊。')] : []),
    t('确认这份清单后会进入 APP 创建确认；也可以修改要求，或回复“不要”取消。'),
  ].join('\n');
};
