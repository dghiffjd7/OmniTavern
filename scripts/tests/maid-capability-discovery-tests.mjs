import assert from 'node:assert/strict';
import { listAppFeatures, searchAppFeatures } from '../../src/scripts/agent/app-feature-catalog.js';
import { searchMaidCapabilityConcepts } from '../../src/scripts/agent/maid-capability-concept-retriever.js';
import { createMaidCapabilityRetriever } from '../../src/scripts/agent/maid-capability-routing.js';

const features = listAppFeatures();
const retriever = createMaidCapabilityRetriever();
const ids = input => retriever.retrieve(input, { features, limit: 8 }).map(item => item.id);
const concepts = input => searchMaidCapabilityConcepts(input, { features }).map(item => item.id);

{
  const input = '帮我建一个联系人，叫千夏，18岁的图书管理员，性格安静，喜欢推理小说';
  const result = ids(input);
  assert.equal(result[0], 'session.create');
  for (const expected of ['contact_profile.upsert', 'contact_profile.read', 'session.list']) {
    assert.ok(result.includes(expected), `${expected} must be discoverable for a complete contact profile`);
  }
  assert.ok(searchAppFeatures(input, { limit: 4 }).some(item => item.id === 'session.create'));
  assert.ok(ids('帮我建个好友，叫千夏').includes('session.create'));
  assert.ok(concepts('帮我添加一个好友，叫千夏').includes('session.create'));
  assert.ok(!concepts('给聊天室添加一张图片').includes('session.create'));
  assert.ok(ids('看看联系人小雪的性格资料').includes('contact_profile.read'));
  assert.ok(!concepts('只看联系人小雪的资料，不要创建联系人或修改档案').includes('contact_profile.upsert'));
  assert.ok(!concepts('只看联系人小雪的资料，不要创建联系人或修改档案').includes('session.create'));
  console.log('ok - colloquial contact requests retrieve creation and complete profile storage without negated writes');
}

{
  for (const input of ['拉个群，小雪莉莉丝阿凯都进来', '帮我建个群，让小雪和莉莉丝一起聊', '从现有联系人里创建一个群聊']) {
    assert.equal(ids(input)[0], 'group.create', input);
  }
  assert.ok(!concepts('不要拉个群，只看看联系人名单').includes('group.create'));
  assert.ok(!concepts('群众喜欢新建的图书馆').includes('group.create'));
  console.log('ok - colloquial group creation is found without treating negated actions or crowds as groups');
}

{
  for (const placeholder of ['<user>', '{{user}}', '<USER>', '{{ user }}']) {
    const input = `新增一个青梅竹马，名字就叫林念初，性格傲娇活泼暗恋${placeholder}`;
    const result = ids(input);
    assert.ok(!result.includes('user.create'), input);
    for (const expected of ['worldbook.list', 'worldbook.read', 'worldbook.create']) {
      assert.ok(result.includes(expected), `${input} must retrieve ${expected}`);
    }
  }
  assert.ok(concepts('新增一个用户档案，名字叫小白').includes('user.create'));
  assert.ok(concepts('create a user profile called Alice').includes('user.create'));
  assert.ok(!concepts('新增一个角色卡，简介是{{user}}的青梅竹马').includes('worldbook.create'));
  assert.ok(!concepts('新增一个联系人，是<user>的青梅竹马').includes('worldbook.create'));
  assert.ok(!concepts('不要新增一个青梅竹马，先看当前角色卡').includes('worldbook.create'));
  console.log('ok - story placeholders preserve creative worldbook intent without creating APP user identities');
}
