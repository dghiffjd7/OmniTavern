import assert from 'node:assert/strict';

import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createProfileUpdateTool } from '../../src/scripts/agent/tools/profile-update-tool.js';

const createProfileStore = (items, activeId) => {
  const list = items.map(item => ({ ...item }));
  return {
    list,
    getAll: () => list,
    get: id => list.find(item => item.id === id) || null,
    getActive: () => list.find(item => item.id === activeId) || null,
    update: async (id, patch) => {
      const item = list.find(entry => entry.id === id);
      if (!item) return null;
      Object.assign(item, patch);
      return item;
    },
  };
};

const createContactsStore = (items) => {
  const contacts = Object.fromEntries(items.map(item => [item.id, { ...item }]));
  return {
    contacts,
    listContacts: () => Object.values(contacts),
    getContact: id => contacts[id] || null,
    upsertContact: (contact) => { contacts[contact.id] = { ...contacts[contact.id], ...contact }; },
  };
};

const setup = () => {
  const userStore = createProfileStore([{ id: 'default', name: '我', description: '' }, { id: 'user-2', name: '阿明' }], 'default');
  const personaStore = createProfileStore([
    { id: 'p1', name: '艾琳', description: '旧设定', source: { type: 'character_card', characterName: '艾琳', worldbookId: 'wb1' } },
    { id: 'p2', name: '莉莉' },
  ], 'p1');
  const contactsStore = createContactsStore([
    { id: 'chat-a', name: '艾琳', isGroup: false },
    { id: 'group:1', name: '周末群', isGroup: true, members: ['chat-a'] },
  ]);
  const events = [];
  const messages = [];
  const tool = createProfileUpdateTool({
    userStore,
    personaStore,
    contactsStore,
    chatStore: { getCurrent: () => 'chat-a', appendMessage: (message, sessionId) => messages.push({ message, sessionId }) },
    onPersonaProfileUpdated: detail => events.push(['persona', detail.personaId]),
    onUserProfileUpdated: detail => events.push(['user', detail.userId]),
    refreshChatAndContacts: detail => events.push(['refresh', detail.sessionId]),
  });
  const registry = createAgentToolRegistry({ logger: { warn() {}, debug() {} } });
  registry.register(tool);
  const confirmations = [];
  let answer = 'allow';
  const run = (args, extra = {}) => registry.executeTool('profile.update', args, {
    requestToolConfirmation: (request) => { confirmations.push(request); return { decision: answer }; },
    ...extra,
  });
  return { userStore, personaStore, contactsStore, events, messages, confirmations, run, setAnswer: value => { answer = value; } };
};

// 改当前用户名：弹窗展示改前改后，确认后写入并走用户面板的刷新
{
  const env = setup();
  const result = await env.run({ kind: 'user', name: '小明' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.updated, true);
  assert.equal(env.userStore.get('default').name, '小明');
  assert.equal(env.confirmations.length, 1);
  assert.equal(env.confirmations[0].kind, 'profile.update');
  assert.equal(env.confirmations[0].operationType, 'update_profile', 'a rename is an ordinary edit, not an overwrite');
  assert.equal(env.confirmations[0].danger, false);
  assert.match(env.confirmations[0].message, /「我」→「小明」/);
  assert.match(env.confirmations[0].message, /内部 id、聊天记录与绑定不变/);
  assert.deepEqual(env.events, [['user', 'default']]);
  console.log('ok - renaming the active user confirms before/after and refreshes like the user panel');
}

// 预览不弹窗、不写入；取消确认不写入
{
  const env = setup();
  const preview = await env.run({ kind: 'user', name: '小明', preview: true });
  assert.equal(preview.result.preview, true);
  assert.deepEqual(preview.result.changes, [{ field: 'name', before: '我', after: '小明' }]);
  assert.equal(env.confirmations.length, 0);
  assert.equal(env.userStore.get('default').name, '我');
  env.setAnswer('deny');
  await env.run({ kind: 'user', name: '小明' }).catch(() => null);
  assert.equal(env.userStore.get('default').name, '我', 'a declined confirmation writes nothing');
  console.log('ok - preview and a declined confirmation leave the profile unchanged');
}

// 重名、找不到、同名多个目标、无改动都不写入
{
  const env = setup();
  const conflict = await env.run({ kind: 'user', name: '阿明' });
  assert.equal(conflict.result.reason, 'name_conflict');
  const missing = await env.run({ kind: 'persona', target: '不存在', name: '新名' });
  assert.equal(missing.result.reason, 'persona_not_found');
  env.personaStore.list.push({ id: 'p3', name: '莉莉' });
  const ambiguous = await env.run({ kind: 'persona', target: '莉莉', name: '莉莉二号' });
  assert.equal(ambiguous.result.reason, 'ambiguous_target');
  const same = await env.run({ kind: 'user', name: '我' });
  assert.equal(same.result.changed, false);
  assert.equal(env.confirmations.length, 0, 'nothing to confirm when nothing changes');
  console.log('ok - conflicts, missing or ambiguous targets and no-op edits never write');
}

// 角色卡改名同步来源里的角色名，id 与绑定不变；改简介有旧内容时弹窗标为危险
{
  const env = setup();
  await env.run({ kind: 'persona', target: '艾琳', name: '艾琳娜' });
  const persona = env.personaStore.get('p1');
  assert.equal(persona.name, '艾琳娜');
  assert.equal(persona.source.characterName, '艾琳娜');
  assert.equal(persona.source.worldbookId, 'wb1', 'bindings are kept');
  assert.deepEqual(env.events, [['persona', 'p1']]);
  await env.run({ kind: 'persona', target: 'p1', description: '新设定' });
  assert.equal(env.confirmations.at(-1).danger, true, 'replacing existing description text is flagged');
  assert.equal(env.confirmations.at(-1).operationType, 'replace_existing');
  assert.equal(persona.description, '新设定');
  console.log('ok - character cards keep id and bindings; replacing a description is flagged as dangerous');
}

// 聊天室：省略 target 改当前聊天室；群聊改名追加系统提示并刷新
{
  const env = setup();
  await env.run({ kind: 'contact', name: '艾琳（工作）' });
  assert.equal(env.contactsStore.getContact('chat-a').name, '艾琳（工作）');
  assert.equal(env.messages.length, 0, 'private chats get no system line');
  await env.run({ kind: 'contact', target: '周末群', name: '周末小组' });
  assert.equal(env.contactsStore.getContact('group:1').name, '周末小组');
  assert.deepEqual(env.contactsStore.getContact('group:1').members, ['chat-a']);
  assert.match(env.messages[0].message.content, /群聊名称已更新：周末群 → 周末小组/);
  assert.deepEqual(env.events, [['refresh', 'chat-a'], ['refresh', 'group:1']]);
  console.log('ok - chat rooms rename in place, groups log the rename like the settings panel');
}

// 确认期间目标被别处改过时不覆盖
{
  const env = setup();
  const result = await env.run({ kind: 'user', name: '小明' }, {
    requestToolConfirmation: () => { env.userStore.get('default').name = '别处改的'; return { decision: 'allow' }; },
  });
  assert.equal(result.result.reason, 'target_changed_during_confirmation');
  assert.equal(env.userStore.get('default').name, '别处改的');
  console.log('ok - a target edited during confirmation is not overwritten');
}

// 排队的语音任务沿用交办时房间；显式 target 仍优先，房间已删除时不回退到当前房间。
{
  const env = setup();
  await env.run({ kind: 'contact', name: '原房间改名' }, { voiceCallId: 'call', sessionId: 'group:1' });
  assert.equal(env.contactsStore.getContact('group:1').name, '原房间改名');
  assert.equal(env.contactsStore.getContact('chat-a').name, '艾琳');
  await env.run({ kind: 'contact', target: 'chat-a', name: '指定房间' }, { voiceCallId: 'call', sessionId: 'group:1' });
  assert.equal(env.contactsStore.getContact('chat-a').name, '指定房间');
  const missing = await env.run({ kind: 'contact', name: '不应写入' }, { voiceCallId: 'call', sessionId: 'removed-room' });
  assert.equal(missing.result.reason, 'contact_not_found');
  assert.equal(env.contactsStore.getContact('chat-a').name, '指定房间');
  console.log('ok - voice profile edits retain the captured room and respect explicit targets');
}

// 三类资料均在真正写入前复验重名，不只在打开确认时检查。
for (const [kind, target, conflictId] of [['user', 'default', 'user-2'], ['persona', 'p1', 'p2'], ['contact', 'chat-a', 'group:1']]) {
  const env = setup();
  const store = kind === 'contact' ? env.contactsStore : kind === 'user' ? env.userStore : env.personaStore;
  const get = id => kind === 'contact' ? store.getContact(id) : store.get(id);
  const previousName = get(target).name;
  const result = await env.run({ kind, target, name: '新名称' }, {
    requestToolConfirmation: () => { get(conflictId).name = '新名称'; return { decision: 'allow' }; },
  });
  assert.equal(result.result.reason, 'name_conflict');
  assert.equal(get(target).name, previousName);
}
console.log('ok - a name claimed during confirmation prevents writes for all profile kinds');
// 当前卡按交办房间锁定解析；显式目标优先，悬空锁定不误改全局卡。
{
  const cards = createProfileStore([{ id: 'global', name: '全局卡' }, { id: 'locked', name: '房间卡' }], 'global');
  const locks = { original: 'locked', missing: 'removed' };
  const tool = createProfileUpdateTool({ personaStore: cards,
    chatStore: { getCurrent: () => 'current', getPersonaLock: id => locks[id] || '' },
  });
  const args = { kind: 'persona', name: '新名称', preview: true };
  assert.equal((await tool.execute(args, { sessionId: 'original', voiceCallId: 'call' })).target.id, 'locked');
  assert.equal((await tool.execute({ ...args, target: 'global' }, { sessionId: 'original' })).target.id, 'global');
  assert.equal((await tool.execute(args, { sessionId: 'missing' })).reason, 'persona_not_found');
  assert.equal((await tool.execute(args, {})).target.id, 'global');
  locks.current = 'locked';
  assert.equal((await tool.execute(args, {})).target.id, 'locked');
  assert.equal(cards.get('global').name, '全局卡');
  console.log('ok - current persona follows the captured room lock and respects explicit targets');
}
console.log('profile update tool tests passed');
