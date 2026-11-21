import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaidToolConfirmationRuntime } from '../../src/scripts/ui/maid-tool-confirmation-runtime.js';
import { createAgentToolSafetyAllowStore } from '../../src/scripts/agent/agent-tool-safety-allow-store.js';

// 确认窗三个选项（11/20 用户定）：允许一次／这个任务一律允许／这个角色卡一律允许；
// MCP 保留全局「始终允许」；只读升级与「开启内置能力」不提供记住的选项。

const scope = (extra = {}) => ({ runId: 'run-a', submissionId: 'sub-a', roleCardId: 'card-a', sessionId: 's-a', uiMode: 'maid', ...extra });
const writeRequest = (extra = {}) => ({
  toolName: 'persona.create', kind: 'persona.create', operationType: 'create_persona',
  title: '新建角色卡', message: '将新建角色卡「千夏」。', ...extra,
});
const memoryStorage = () => {
  const data = new Map();
  return { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k) };
};
const setup = (answers = []) => {
  const opened = [];
  const allowStore = createAgentToolSafetyAllowStore({ storage: memoryStorage(), now: () => 1000 });
  const runtime = createMaidToolConfirmationRuntime({
    allowStore,
    getRoleCardName: id => ({ 'card-a': '小雪', 'card-b': '莉莉丝' }[id] || ''),
    choose: args => { opened.push(args); return Promise.resolve(answers.shift() || 'deny'); },
  });
  return { runtime, allowStore, opened };
};
const actionIds = opened => opened.map(args => args.actions.map(action => action.id));

test('ordinary writes offer allow once, this task and this role card', async () => {
  const { runtime, opened } = setup(['allow_once']);
  assert.deepEqual(await runtime.request(writeRequest(), scope()), { decision: 'allow' });
  assert.deepEqual(actionIds(opened)[0], ['allow_role_card', 'allow_task', 'deny', 'allow_once']);
  const labels = opened[0].actions.map(action => action.label);
  assert.ok(labels.includes('这个任务一律允许') && labels.includes('这个角色卡一律允许'));
  assert.ok(!labels.includes('始终允许'), '一般写入不再提供全局始终允许');
});

test('legacy allowAlways:false only removes global always, not task or role card scope', async () => {
  const { runtime, opened } = setup(['deny']);
  await runtime.request(writeRequest({ toolName: 'group.create', kind: 'group.create', operationType: 'create_group_chat', allowAlways: false }), scope());
  assert.deepEqual(actionIds(opened)[0], ['allow_role_card', 'allow_task', 'deny', 'allow_once']);
});

test('this task lasts across requests and role cards until the maid conversation is cleared', async () => {
  // 11/20 用户定：对应 Noa 的会话。女仆只有一条连续的对话，所以重开 APP 或清空女仆对话前都有效
  const { runtime, opened } = setup(['allow_task', 'deny']);
  assert.deepEqual(await runtime.request(writeRequest(), scope()), { decision: 'allow', remembered: 'task' });
  assert.deepEqual(await runtime.request(writeRequest({ message: '将新建角色卡「Luna」。' }), scope({ runId: 'run-a2', submissionId: 'sub-b' })), { decision: 'allow', remembered: 'task' });
  assert.deepEqual(await runtime.request(writeRequest(), scope({ submissionId: 'sub-c', roleCardId: 'card-b' })), { decision: 'allow', remembered: 'task' },
    '切换角色卡后照样有效');
  assert.equal(opened.length, 1);
  await runtime.request(writeRequest({ toolName: 'user.create', kind: 'user.create', operationType: 'create_user' }), scope());
  assert.equal(opened.length, 2, '别的操作仍要问');
  runtime.clearTaskAllowances();
  await runtime.request(writeRequest(), scope());
  assert.equal(opened.length, 3, '清空女仆对话后重新问');
});

test('this role card stores a scoped rule that only that card reuses', async () => {
  const { runtime, allowStore, opened } = setup(['allow_role_card', 'deny']);
  assert.deepEqual(await runtime.request(writeRequest(), scope()), { decision: 'allow', remembered: 'role_card' });
  const [rule] = allowStore.list();
  assert.equal(rule.roleCardId, 'card-a');
  assert.equal(rule.roleCardName, '小雪');
  assert.deepEqual(await runtime.request(writeRequest(), scope({ submissionId: 'sub-later' })), { decision: 'allow', remembered: 'role_card' });
  assert.equal(opened.length, 1);
  assert.deepEqual(await runtime.request(writeRequest(), scope({ roleCardId: 'card-b' })), { decision: 'deny' });
  assert.equal(opened.length, 2, '别的角色卡要重新问');
});

test('existing global rules keep allowing every role card', async () => {
  const { runtime, allowStore, opened } = setup();
  allowStore.allowAlways(writeRequest());
  assert.deepEqual(await runtime.request(writeRequest(), scope({ roleCardId: 'card-b' })), { decision: 'allow', remembered: 'global' });
  assert.equal(opened.length, 0);
});

test('MCP keeps the global always-allow option', async () => {
  const { runtime, allowStore, opened } = setup(['allow_always']);
  const mcp = writeRequest({ toolName: 'mcp.call', kind: 'mcp.call', operationType: 'mcp:abc', allowScope: 'global' });
  assert.deepEqual(await runtime.request(mcp, scope()), { decision: 'allow', remembered: 'global' });
  assert.deepEqual(actionIds(opened)[0], ['allow_always', 'deny', 'allow_once']);
  assert.equal(allowStore.isAllowed(mcp), true, 'MCP 规则是全局的，自建 Agent 也认得');
});

test('read-only escalation and persistent enabling never offer remembering', async () => {
  const { runtime, allowStore, opened } = setup(['allow_task', 'allow_role_card', 'allow_task']);
  await runtime.request(writeRequest({ escalation: 'read_only_write' }), scope());
  await runtime.request(writeRequest({ details: { purpose: 'persistent_enable' } }), scope());
  assert.deepEqual(actionIds(opened), [['deny', 'allow_once'], ['deny', 'allow_once']]);
  assert.deepEqual(await runtime.request(writeRequest({ escalation: 'read_only_write' }), scope()), { decision: 'allow' },
    '没提供的记住选项送回来时只按允许一次处理');
  assert.equal(opened.length, 3, '没有记住：同一任务里仍然要问');
  assert.equal(allowStore.list().length, 0);
});

test('without a role card only this task can be remembered', async () => {
  const { runtime, opened } = setup();
  await runtime.request(writeRequest(), scope({ submissionId: '' }));
  await runtime.request(writeRequest(), scope({ roleCardId: '' }));
  assert.deepEqual(actionIds(opened), [['allow_role_card', 'allow_task', 'deny', 'allow_once'], ['allow_task', 'deny', 'allow_once']]);
});

test('inline entries expose which remember options the card can show', async () => {
  const runtime = createMaidToolConfirmationRuntime({ canShowInline: () => true, getRoleCardName: () => '小雪' });
  const pending = runtime.request(writeRequest(), scope());
  const entry = runtime.getInline('run-a');
  assert.equal(entry.allowTask, true);
  assert.equal(entry.allowRoleCard, true);
  assert.equal(entry.allowAlways, false);
  assert.equal(entry.roleCardName, '小雪');
  runtime.resolve(entry.id, 'deny');
  assert.deepEqual(await pending, { decision: 'deny' });
});

test('deletions and archiving can be allowed for this task but never per role card', async () => {
  const { runtime, allowStore, opened } = setup(['allow_role_card', 'allow_task']);
  const del = writeRequest({ toolName: 'variable.delete', kind: 'variable.delete', operationType: 'delete_variables' });
  assert.deepEqual(await runtime.request(del, scope()), { decision: 'allow' }, '没提供的角色卡选项只按允许一次处理');
  assert.equal(allowStore.list().length, 0, '删除不会存成角色卡规则');
  assert.deepEqual(actionIds(opened)[0], ['allow_task', 'deny', 'allow_once']);
  await runtime.request(writeRequest({ toolName: 'maid.memory.archive', kind: 'maid.memory.archive', operationType: 'archive_maid_memories' }), scope());
  assert.deepEqual(actionIds(opened)[1], ['allow_task', 'deny', 'allow_once']);
});

test('a choice card marked allowRemember:false offers no remember option and keeps its own button text', async () => {
  const { runtime, opened } = setup(['allow_task']);
  const choice = writeRequest({ toolName: 'moments.publish', kind: 'moments.image_failed', operationType: 'create',
    allowAlways: false, allowRemember: false, confirmText: '发已生成的 1 张', cancelText: '先不发' });
  assert.deepEqual(await runtime.request(choice, scope()), { decision: 'allow' }, '送回记住选项只按这一次处理');
  assert.deepEqual(opened[0].actions.map(action => action.label), ['先不发', '发已生成的 1 张']);
  await runtime.request(choice, scope());
  assert.equal(opened.length, 2, '没有记住，下次照样问');
});
