const FLOW_CHIPS = Object.freeze([
  { id: 'setup-api', label: '接好 API', flowId: 'setup-api' },
  { id: 'add-friend', label: '添加好友', flowId: 'add-friend' },
  { id: 'first-chat', label: '第一次对话', flowId: 'first-chat' },
  { id: 'meet-maid', label: '认识女仆', flowId: 'meet-maid' },
]);

const includesAny = (text, keys) => keys.some(key => text.includes(key));

export const matchMaidIntent = (raw = '') => {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return null;
  const compact = text.replace(/[\s，,。.!！?？、；;：:「」『』“”"'`]/g, '');
  const hasTeachingCue = includesAny(text, [
    '怎么',
    '如何',
    '教我',
    '指导我',
    '一步步',
    '一步一步',
    '第一次',
  ]);

  if (includesAny(text, ['跳过', '退出引导', '停止引导', '取消引导', '不用引导'])) {
    return {
      kind: 'skip',
      reply: '好嘞，引导已收起。主人什么时候想继续，随时喊我～',
      chips: FLOW_CHIPS,
    };
  }

  // 不用裸「引导」做判定：「请引导我打开世界书」这类功能引导请求要落给真实女仆
  if (includesAny(text, ['新手', '教程', '教学', '上手', '带我逛', '怎么开始'])) {
    return {
      kind: 'catalog',
      reply: '欢迎回家，主人～我备好了 4 堂新手小课，选一堂就能跟着聚光灯一步步完成：',
      chips: FLOW_CHIPS,
    };
  }

  const hasApiTopic = includesAny(text, ['api', 'apikey', 'api key', '接线', '连线', '配置模型', '模型配置']);
  // Error details are evidence for troubleshooting, not a request to open setup.
  const hasApiTroubleshooting = /报错|錯誤|错误|失敗|失败|异常|異常|超时|逾時|unauthorized|invalid\s+(?:api\s*)?key|\b(?:error|failed|timeout|[45]\d{2})\b/iu.test(text);
  const hasApiSetupRequest = /(?:怎么|如何|教我|指导我|一步步|一步一步|第一次)[^，。！？\n]{0,18}(?:配置|设置|填写|填入|填|接入|连接|绑定|接上|接好)[^，。！？\n]{0,12}(?:api|接线|连线|模型)/iu.test(text)
    || /(?:api(?:\s*key)?|模型)[^，。！？\n]{0,12}(?:怎么|如何)[^，。！？\n]{0,8}(?:配置|设置|填写|填入|填|接入|连接|绑定|接上|接好)/iu.test(text);
  if (
    (hasApiTopic && hasApiSetupRequest && !hasApiTroubleshooting) ||
    ['接好api', '给女仆接api', '给女仆接上api'].includes(compact)
  ) {
    return {
      kind: 'flow',
      flowId: 'setup-api',
      reply: '收到～这就带主人给女仆接上 API，大约两分钟就好。',
    };
  }

  const hasFriendTopic = includesAny(text, ['添加好友', '加好友', '推荐好友', '推荐角色', '认识角色', '联系人']);
  const wantsFriend = (
    (hasTeachingCue && hasFriendTopic) ||
    ['添加好友', '我想添加好友', '推荐好友', '推荐角色', '认识角色'].includes(compact)
  );
  if (wantsFriend) {
    return {
      kind: 'flow',
      flowId: 'add-friend',
      reply: '包在我身上～我们去推荐列表认识第一位角色好友。',
    };
  }

  const hasChatTopic = includesAny(text, ['对话', '聊天', '发消息', '发送消息']);
  const wantsChat = (
    (hasTeachingCue && hasChatTopic) ||
    ['第一次对话', '第一次聊天', '开始第一次对话', '开始第一次聊天'].includes(compact)
  );
  if (wantsChat) {
    return {
      kind: 'flow',
      flowId: 'first-chat',
      reply: '想和角色聊天？安排！「第一次对话」引导这就开始。',
    };
  }

  const hasMaidTopic = includesAny(text, ['agent center', 'agent中心', 'agent 中心', '认识女仆', '女仆工作台', '小助手', '怎么用女仆']);
  if (
    (hasTeachingCue && hasMaidTopic) ||
    ['认识女仆', '怎么用女仆'].includes(compact)
  ) {
    return {
      kind: 'flow',
      flowId: 'meet-maid',
      reply: '收到。这就带主人巡视女仆工作台和 Agent Center。',
    };
  }

  return null;
};

export const listMaidIntentChips = () => FLOW_CHIPS.map(chip => ({ ...chip }));
