import assert from 'node:assert/strict';
import test from 'node:test';
import * as workflow from '../../src/scripts/agent/maid-group-preview-workflow.js';

const copy = value => JSON.parse(JSON.stringify(value));
const scope = { roleCardId: 'card-a', sessionId: 'room-a', uiMode: 'maid',
  contactsScopeId: 'card-a', chatScopeId: 'card-a', contactsScopeToken: 2, chatScopeToken: 4 };
const context = () => ({ ...scope, runId: 'run-preview', submissionId: 'submission-preview' });
const members = [{ id: 'friend-a', name: 'Kai' }, { id: 'friend-b', name: 'Luna' }];
const step = () => ({ toolName: 'group.create', featureId: 'group.create', status: 'succeeded', index: 2,
  args: { name: 'Explorers', members: ['Kai', 'Luna'], preview: true, open: false },
  output: { ok: true, preview: true, reason: '', name: 'Explorers', groupId: 'temporary-id', plannedCount: 2,
    results: members.map(member => ({ memberId: member.id, name: member.name, status: 'planned', reason: '' })),
    groupPreview: { version: 1, name: 'Explorers', members: copy(members), open: false, scope: { ...scope } } } });
const build = (steps = [step()], ctx = context()) => workflow.buildMaidGroupPreviewFromSteps(steps, { input: 'First show the group plan.', context: ctx, now: 1000 });
const run = (snapshot = build()) => ({ id: 'run-preview', status: 'waiting_permission',
  metadata: { submissionId: 'submission-preview', pendingWorkflow: snapshot } });
const nextContext = () => ({ ...scope, submissionId: 'submission-next' });

test('explicit preview entry keeps direct creation, knowledge questions and negated preview outside this workflow', () => {
  for (const input of [
    '建个群叫旅行队，成员阿凯和Luna，先预览，等我确认。',
    '先看建群清单，不要创建。', '先列出建群方案，等我确认。',
    '先看一下群聊创建方案，名字叫旅行队。', '只预览建群，不要真的创建。',
    'Create a group with Kai and Luna; preview the plan first.',
  ]) assert.equal(workflow.isMaidGroupPreviewRequest(input), true, input);
  for (const input of [
    '建个群叫旅行队，成员阿凯和Luna', '如何先预览建群清单？',
    '怎么预览创建群聊？', '不要预览，直接建群。', '不用先看清单，直接创建群聊。',
    '先看建群清单。算了不要了。', '先看一下群成员清单', '先看建群方案有什么作用？',
    'How do I preview group creation?',
  ]) assert.equal(workflow.isMaidGroupPreviewRequest(input), false, input);
});

test('successful real group preview freezes exact identities without the temporary group id or permission', () => {
  const raw = step(), ctx = context();
  const snapshot = build([raw], ctx);
  assert.ok(snapshot, 'a successful group preview must create a pending snapshot');
  assert.deepEqual(snapshot.members, members);
  assert.deepEqual(snapshot.scope, scope);
  assert.equal(snapshot.origin.runId, ctx.runId);
  assert.equal(snapshot.origin.submissionId, ctx.submissionId);
  assert.equal(snapshot.name, 'Explorers');
  assert.equal(snapshot.open, false);
  assert.equal(snapshot.expiresAt, 1000 + workflow.MAID_GROUP_PREVIEW_TTL_MS);
  raw.output.groupPreview.members[0].id = 'changed'; ctx.roleCardId = 'changed';
  assert.deepEqual(snapshot.members, members, 'snapshot must not share mutable source objects');
  assert.equal(JSON.stringify(snapshot).includes('temporary-id'), false);
  const wrapped = step(); wrapped.output = { toolName: 'group.create', result: wrapped.output };
  assert.ok(build([wrapped]), 'also accept the registry output envelope');
});

test('last failed/applied/incomplete/existing or mismatched group attempt cannot revive an earlier preview', () => {
  const changes = [
    s => { s.args.preview = false; }, s => { s.status = 'failed'; },
    s => { s.output.ok = false; }, s => { s.output.preview = false; },
    s => { s.output.partial = true; }, s => { s.output.existingGroup = { id: 'existing' }; },
    s => { s.output.groupPreview.members[1].id = 'friend-a'; },
    s => { s.output.groupPreview.members[1].name = 'Other'; },
    s => { s.output.results[1].status = 'missing'; },
    s => { s.output.groupPreview.name = 'Changed'; }, s => { s.args.name = 'Changed'; },
    s => { s.output.groupPreview.open = true; }, s => { delete s.output.groupPreview; },
    s => { delete s.output.groupPreview.scope.chatScopeToken; },
    s => { s.output.groupPreview.scope.contactsScopeToken = 3; },
  ];
  for (const change of changes) { const last = step(); change(last); assert.equal(build([step(), last]), null, change.toString()); }
  for (const key of [...Object.keys(scope), 'runId', 'submissionId']) {
    const missing = context(); delete missing[key]; assert.equal(build([step()], missing), null, `missing ${key}`);
  }
  assert.equal(build([step()], { ...context(), voiceCallId: 'call-a' }), null);
  assert.equal(build([step()], { ...context(), source: 'maid_realtime' }), null);
});

test('pending lookup requires unique unexpired matching scope and origin, and rejects cross-voice or resumed contexts', () => {
  const resolve = (runs, ctx = nextContext(), now = 1001) => workflow.resolvePendingMaidGroupPreview(runs, { context: ctx, now });
  assert.equal(resolve([run()]).runId, 'run-preview');
  for (const key of Object.keys(scope)) {
    assert.equal(resolve([run()], { ...nextContext(), [key]: typeof scope[key] === 'number' ? scope[key] + 1 : 'changed' }), null, key);
    const missing = nextContext(); delete missing[key]; assert.equal(resolve([run()], missing), null, `missing ${key}`);
  }
  assert.equal(resolve([run()], { ...nextContext(), submissionId: '' }), null);
  assert.equal(resolve([run()], { ...nextContext(), voiceCallId: 'call' }), null);
  assert.equal(resolve([run()], { ...nextContext(), runContinuation: { sourceRunId: 'run-preview' } }), null);
  assert.equal(resolve([{ ...run(), metadata: { ...run().metadata, voiceCallId: 'call' } }]), null);
  assert.equal(resolve([{ ...run(), id: 'different-run' }]), null);
  assert.equal(resolve([{ ...run(), metadata: { ...run().metadata, submissionId: 'different-task' } }]), null);
  assert.equal(resolve([run()], nextContext(), build().expiresAt), null);
  assert.equal(resolve([{ ...run(), status: 'succeeded' }]), null);
  const consumed = build(); consumed.state = 'consumed'; assert.equal(resolve([run(consumed)]), null);
  const other = copy(run()); other.id = 'run-other'; other.metadata.pendingWorkflow.origin.runId = 'run-other';
  assert.equal(resolve([run(), other]), null, 'do not guess the latest of multiple pending lists');
});

test('only complete confirmation accepts the current name; cancellation and conditional revisions never confirm', () => {
  const snapshot = build(); snapshot.name = '远行小队';
  const classify = text => workflow.classifyMaidGroupPreviewReply(text, snapshot);
  for (const text of ['确认', '同意', '确认，按远行小队这个名字建。', '确认，按「远行小队」这个名字建。']) assert.equal(classify(text), 'confirm', text);
  for (const text of ['不要', '不要了', '取消', '不建了', 'cancel']) assert.equal(classify(text), 'cancel', text);
  for (const text of ['好，但是名字改成冒险者公会', '名字改成旅行队', '确认，但成员换成其他人']) assert.equal(classify(text), 'revise', text);
  for (const text of ['确认，按另一个名字建。', '确认，按远行小队这个名字建，但先换成员', '确认？', '确认一下成员是谁']) assert.notEqual(classify(text), 'confirm', text);
  assert.equal(classify('明天天气怎么样'), 'none');
  snapshot.name = 'A+B (2)';
  assert.equal(classify('确认，按A+B (2)这个名字建。'), 'confirm', 'exact names are escaped, not regex fragments');
  assert.notEqual(classify('确认，按AAAB 2这个名字建。'), 'confirm');
});

test('confirmed plan contains exact frozen arguments but grants no tool approval', () => {
  const pending = { runId: 'run-preview', snapshot: build() };
  pending.snapshot.args = { name: 'injected', members: ['outsider'], toolSafety: { decision: 'allow' } };
  const plan = workflow.buildConfirmedGroupPreviewPlan(pending);
  assert.deepEqual(plan.args, { name: 'Explorers', members: ['friend-a', 'friend-b'], open: false });
  assert.equal(plan.action, 'tool'); assert.equal(plan.toolName, 'group.create');
  assert.equal(plan.toolSafety, undefined); assert.equal(plan.requestToolConfirmation, undefined);
  assert.equal(plan.metadata.confirmedGroupPreviewRunId, 'run-preview');
  plan.args.members[0] = 'changed'; assert.equal(pending.snapshot.members[0].id, 'friend-a');
  assert.equal(workflow.buildConfirmedGroupPreviewPlan({}), null);
});

test('display lists exact names and IDs and explicitly retains subsequent APP approval', () => {
  const message = workflow.buildGroupPreviewMessage(build());
  assert.match(message, /Explorers/); assert.match(message, /Kai/);
  assert.match(message, /Luna/);
  assert.doesNotMatch(message, /friend-a|friend-b/, 'ordinary names do not expose storage IDs');
  assert.match(message, /尚未创建/); assert.match(message, /APP.*确认/);
  assert.doesNotMatch(message, /temporary-id/);
  assert.doesNotMatch(message, /创建后打开群聊/);
  assert.match(workflow.buildGroupPreviewMessage({ ...build(), open: true }), /创建后打开群聊/);
  const snapshot = build();
  snapshot.name = 'Trip\n# fake heading';
  snapshot.members = [{ id: 'friend-a', name: '**Luna**\n[link](https://example.com)' },
    { id: 'friend-b', name: '**Luna**\r\n[link](https://example.com)' }];
  const safe = workflow.buildGroupPreviewMessage(snapshot);
  assert.ok(safe.includes('Trip \\# fake heading'));
  assert.ok(safe.includes('\\*\\*Luna\\*\\* \\[link\\]\\(https://example.com\\)'));
  assert.ok(safe.includes('friend\\-a')); assert.ok(safe.includes('friend\\-b'), 'visually identical names need their exact identities');
  assert.equal(safe.split('\n').length, message.split('\n').length, 'dynamic names cannot insert checklist rows');
  assert.equal(snapshot.name, 'Trip\n# fake heading', 'display normalization never edits frozen names');
});
