import assert from 'node:assert/strict';

import { createMomentsAgentTools } from '../../src/scripts/agent/tools/moments-tools.js';

const getTool = (tools, name) => tools.find(tool => tool.name === name);

{
  // 正常发布：透传 content 与 generateComments，返回 momentId
  const calls = [];
  const tools = createMomentsAgentTools({
    publishMoment: async (payload) => {
      calls.push(payload);
      return { ok: true, momentId: 'm_1', commentsRequested: payload.generateComments };
    },
  });
  const publish = getTool(tools, 'moments.publish');
  assert.equal(publish.capabilities.write, true);
  assert.equal(publish.capabilities.confirmation, 'allow_once');
  assert.equal(publish.riskLevel, 'medium');

  const result = await publish.execute({ content: '  今天天气真好 @大小姐  ' });
  assert.equal(result.ok, true);
  assert.equal(result.momentId, 'm_1');
  assert.equal(result.commentsRequested, true, '默认发布后生成评论');
  assert.equal(calls[0].content, '今天天气真好 @大小姐', '正文去首尾空白');
  assert.equal(calls[0].generateComments, true);

  const silent = await publish.execute({ content: '安静发一条', generateComments: false });
  assert.equal(silent.commentsRequested, false);
  assert.equal(calls[1].generateComments, false);
  assert.match(publish.summarizeResult(result), /moment published id=m_1/);
  console.log('ok - moments.publish 正常发布与评论开关透传');
}

{
  // 失败与缺依赖路径
  const tools = createMomentsAgentTools({
    publishMoment: async () => ({ ok: false, reason: 'persist_failed', message: '写入失败' }),
  });
  const publish = getTool(tools, 'moments.publish');
  const failed = await publish.execute({ content: 'x' });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'persist_failed');
  assert.match(publish.summarizeResult(failed), /moment publish failed: persist_failed/);

  const empty = await publish.execute({ content: '   ' });
  assert.equal(empty.reason, 'moments_publish_empty');

  const orphan = getTool(createMomentsAgentTools(), 'moments.publish');
  const unavailable = await orphan.execute({ content: 'x' });
  assert.equal(unavailable.reason, 'moments_publish_unavailable', '未注入发布通道时明确报错');
  console.log('ok - moments.publish 失败/空正文/缺通道路径');
}

{
  // 用户决定（2026-11-20）：以用户身份发动态前一律确认，附正文预览；现场生图要提示费用
  const tools = createMomentsAgentTools({
    publishMoment: async () => ({ ok: true, momentId: 'm_1' }),
    generateMomentImage: async () => ({ ok: true, asset: { id: 'a' } }),
  });
  const publish = getTool(tools, 'moments.publish');
  const plain = await publish.safety.preflight({ content: '  今天天气真好  ' });
  assert.deepEqual([plain.destructive, plain.kind, plain.operationType, plain.danger], [true, 'moments.publish', 'create_moment', false]);
  assert.equal(plain.details.items[0].label, '今天天气真好', 'the card previews the text');
  const withImages = await publish.safety.preflight({ content: '配图', imagePrompts: ['猫', '狗'], generateComments: false });
  assert.deepEqual([withImages.kind, withImages.operationType], [plain.kind, plain.operationType], 'kind/operationType stay stable');
  assert.match(withImages.message, /2 张配图.*费用/);
  assert.equal((await publish.safety.preflight({ content: '   ' })).destructive, false, 'empty text publishes nothing');
  assert.equal((await getTool(createMomentsAgentTools(), 'moments.publish').safety.preflight({ content: 'x' })).destructive, false);
  console.log('ok - moments.publish 发布前一律确认（附正文预览）');
}

console.log('moments-tools tests passed');
