const trim = value => String(value ?? '').trim();

const normalize = value => trim(value)
  .normalize('NFKC')
  .toLowerCase();

const list = value => (Array.isArray(value) ? value : [value]).filter(Boolean);

export const stripNegatedMaidCapabilityActions = value => normalize(value)
  .replace(/(?:不要|不得|禁止|无需|不用|不可|不能|避免)\s*[^，,。；;：:！？!?\n]*/gu, ' ')
  .replace(/(^|[，,。；;：:！？!?\n\s]|请)(?:别|莫)\s*[^，,。；;：:！？!?\n]*/gu, '$1 ');

export const searchMaidCapabilityConcepts = (
  query = '',
  { limit = 20, features = [] } = {},
) => {
  const text = normalize(query);
  if (!text) return [];
  const positiveText = stripNegatedMaidCapabilityActions(text);
  const available = new Map(
    (Array.isArray(features) ? features : [])
      .map(feature => [trim(feature?.id), feature])
      .filter(([id]) => id),
  );
  const scores = new Map();
  const add = (ids, score, concept) => {
    list(ids).forEach((id) => {
      if (!available.has(id)) return;
      const current = scores.get(id) || { score: 0, concepts: new Set() };
      current.score = Math.max(current.score, score);
      current.concepts.add(concept);
      scores.set(id, current);
    });
  };
  const has = pattern => pattern.test(text);
  const hasPositive = pattern => pattern.test(positiveText);

  if (has(/(?:连线|连接档|模型档|模型配置|聊天模型|聊天配置|provider|model\s*profiles?|chat\s*(?:model|profiles?)|image\s*scope|scope.{0,12}配置|active\s*档|服务商|secret|key\s*\/?\s*token)/iu)) {
    add('config.model.switch', 98, 'model_profile');
  }
  if (hasPositive(/(?:设置|配置|打开|open|show).{0,16}(?:api|key|模型配置)/iu)) {
    add('config.api.open', 96, 'api_config');
  }

  if (has(/(?:失败记录|最近错误|错误簿|翻车|failurecode|maid\s*failures?|tool\s*failures?|recent\s*errors?)/iu)) {
    add('app.errors.read', 100, 'recent_errors');
  }
  if (has(/(?:where\s+(?:exactly\s+)?am\s+i|app\s*状态|状态接口|当前\s*(?:ui\s*)?(?:模式|页面|位置)|在哪个页面)/iu)) {
    add('app.state.read', 100, 'app_state');
  }
  if (has(/(?:可见界面|当前界面|弹窗|侧栏|眼前.*窗口|visible\s*ui|scan.{0,20}(?:ui|panel)|哪些\s*panel|露出来.*panel)/iu)) {
    add('app.visible_panel.read', 100, 'visible_ui');
  }

  const sessionNoun = /(?:会话|聊天室|房间|测试房|群聊|群组(?:聊天)?|contacts?|groups?|chats?|conversations?|\bsessions?\b|\brooms?\b)/iu;
  const listIntent = /(?:列出|读取|查看|清单|名单|所有|全部|哪些|一共有|几间|多少|各几项|列候选|不唯一|inventory|\blist\b|\bevery\b|names?)/iu;
  if (sessionNoun.test(text) && listIntent.test(text)) {
    add('session.list', 98, 'session_inventory');
  }
  if (
    sessionNoun.test(positiveText) &&
    /(?:创建|新建|新增|建立|\bcreate\b)/iu.test(positiveText)
  ) {
    add('session.create', 100, 'session_create');
  }
  if (
    sessionNoun.test(positiveText) &&
    /(?:批量删除|删除|删掉|移除|清理(?!后)|delete|remove|clean)/iu.test(positiveText)
  ) {
    add('session.delete_many', 105, 'session_batch_delete');
  }
  if (hasPositive(/(?:打开|进入|切到|切换到|\bopen\b|\benter\b|\bswitch\b).{0,24}(?:会话|聊天室|房间|群聊|群组(?:聊天)?|chat|conversation|group)/iu)) {
    add('session.open', 96, 'session_open');
  }
  if (hasPositive(/(?:打开|进入|切到|切换到).{0,12}(?:主要|最终)(?:结果|成果)/iu)) {
    add('session.open', 108, 'session_open_result');
  }
  const groupChatNoun = /(?:群聊|群组(?:聊天)?|group\s*chats?|\bgroups?\b)/iu;
  if (
    groupChatNoun.test(text) &&
    /(?:成员|members?)/iu.test(text) &&
    /(?:只读|查看|读取|确认|核对|哪些|名单|清单|\blist\b|\bread\b|\bcheck\b)/iu.test(text) &&
    !/(?:添加|加入|邀请|拉进|移出|踢出|删除|修改|替换|\badd\b|\bremove\b|\bupdate\b|\breplace\b)/iu.test(positiveText)
  ) {
    add('app.resource.read', 108, 'group_member_read');
  }
  if (
    groupChatNoun.test(positiveText) &&
    /(?:创建|新建|建立|发起|拉一个|\bcreate\b|\bstart\b)/iu.test(positiveText)
  ) {
    add('group.create', 110, 'group_chat_create');
  }
  if (
    /(?:打开|进入|带我去|\bopen\b|\bshow\b)/iu.test(positiveText) &&
    /(?:建群|创建群聊|创建群组|发起群聊).{0,12}(?:界面|页面|入口|panel)?/iu.test(positiveText)
  ) {
    add('group.create.open', 112, 'group_create_panel');
  }
  if (
    groupChatNoun.test(positiveText) &&
    /(?:成员|加(?:上|入|进|人)|邀请|拉进|移出|踢出|删除.{0,6}成员|members?)/iu.test(positiveText)
  ) {
    add('group.members.update', 112, 'group_member_update');
  }

  if (has(/(?:raworiginal|rendered\s*text|latest\s*assistant|最后一轮\s*ai|末条消息|最近一条消息|局部变量|全局变量|local\s*vars?|global\s*vars?|\bvars?\b|后处理规则|后处理脚本|正规表达式|\bregexp\b|\bregex\b|\bpreset\b|角色皮|角色卡|character\s*cards?|user\s*identit(?:y|ies)|用户名称|当前身份)/iu)) {
    add('app.resource.read', 100, 'structured_resource');
  }
  if (
    hasPositive(/(?:发送|写(?:入)?|发出|send|write).{0,16}(?:消息|message)/iu) ||
    hasPositive(/(?:给|向).{0,80}(?:后台)?写入.{0,80}(?:triggerreply\s*:\s*false|只写不回|open\s*:\s*false)/iu)
  ) {
    add('chat.send_message', 100, 'chat_send');
  }
  if (
    has(/(?:查询|读取|查看|只读核对|读回确认).{0,40}(?:会话|聊天室|观测站|私聊).{0,32}世界书绑定/iu) ||
    has(/(?:会话|聊天室|观测站|私聊).{0,32}世界书绑定.{0,24}(?:查询|读取|查看|只读|核对|确认)/iu) ||
    has(/(?:读取|读回|核对|确认).{0,24}(?:真实)?(?:资源)?状态/iu)
  ) {
    add('app.resource.read', 108, 'resource_verification');
  }
  if (has(/(?:prompt\s*preset|哪份\s*preset|哪一套.*preset)/iu)) {
    add('app.resource.read', 100, 'preset_resource');
  }
  if (hasPositive(/(?:打开|弹出|show|open).{0,16}(?:变量|variables?).{0,12}(?:面板|panel|editor)?/iu)) {
    add('variables.open', 100, 'variables_panel');
  }
  if (hasPositive(/(?:打开|弹出|show|open).{0,16}(?:正则|regex|regexp).{0,12}(?:面板|页面|panel|editor)?/iu)) {
    add('regex.open', 100, 'regex_panel');
  }

  const profileCreateIntent = /(?:创建|新建|新增|建立|添加|\bcreate\b)/iu;
  if (
    profileCreateIntent.test(positiveText) &&
    /(?:用户(?:名称|身份|档案)?|user\s*(?:name|profile|identity)?)/iu.test(positiveText)
  ) {
    add('user.create', 100, 'user_create');
  }
  if (
    profileCreateIntent.test(positiveText) &&
    /(?:角色卡|角色档案|人物卡|character\s*cards?|personas?)/iu.test(positiveText)
  ) {
    add('persona.create', 100, 'persona_create');
  }
  if (
    /(?:角色卡|角色档案|人物卡|character\s*cards?|personas?)/iu.test(positiveText) &&
    /(?:批量删除|删除|删掉|移除|清理(?!后)|delete|remove|clean)/iu.test(positiveText)
  ) {
    add('persona.delete_many', 105, 'persona_batch_delete');
  }

  const inferredWorldbookContentIntent = /(?:读取|查看|核对).{0,80}(?:资料|设定).{0,40}(?:人物|角色).{0,24}(?:地点|事件|世界观)/iu;
  const worldbookIntent = /(?:世界书|世借书|world\s*book|worldbook|world\s*lore|lore\s*library|条目|entry\s*titles?|目录页|(?:replace|覆盖).{0,24}全部内容)/iu;
  if (worldbookIntent.test(text) || inferredWorldbookContentIntent.test(text)) {
    add(['worldbook.read', 'worldbook.list'], 84, 'worldbook_domain');
    add(['worldbook.open', 'worldbook.create', 'worldbook.update_entries', 'worldbook.bind_persona', 'worldbook.bind_session', 'worldbook.bind_sessions', 'worldbook.bind_rp_session'], 58, 'worldbook_domain');
    if (has(/(?:有哪些|名单|书名|几本|library|列出.*世界书|worldbook\s*名单)/iu)) {
      add('worldbook.list', 100, 'worldbook_inventory');
    }
    if (has(/(?:读取|读回|只读|核对|确认|正文|索引|目录|entry\s*titles?|read|verify)/iu)) {
      add('worldbook.read', 100, 'worldbook_read');
    }
    if (hasPositive(/(?:创建|新建|追加|写入|生成|覆盖|replace|append|create|generate|write)/iu)) {
      add(['worldbook.create', 'worldbook.read'], 98, 'worldbook_write');
    }
    if (hasPositive(/(?:修改|更新|改写|update|modify)/iu)) {
      add(['worldbook.update_entries', 'worldbook.read'], 100, 'worldbook_update');
    }
    if (hasPositive(/(?:删除|清理(?!后)|去重|delete|remove|dedupe)/iu)) {
      const entryDelete = /(?:条目|重复|去重|dedupe|entries?|(?:里|中|内)的)/iu.test(text);
      if (entryDelete) {
        add(['worldbook.delete_entries', 'worldbook.read'], 105, 'worldbook_entry_delete');
      } else {
        add(['worldbook.delete_many', 'worldbook.list'], 105, 'worldbook_batch_delete');
      }
    }
    if (hasPositive(/(?:绑(?:定|上|到)|启用|bind)/iu)) {
      const rpOnlyBinding = has(/(?:创意写作|创作会话|写作会话|RP\s*会话|roleplay).{0,28}(?:专属|只|隔离|不.{0,8}私聊)|(?:专属|只).{0,28}(?:创意写作|创作会话|写作会话|RP\s*会话)|不.{0,12}(?:影响|进入|用于).{0,12}私聊/iu);
      if (rpOnlyBinding) {
        add('worldbook.bind_rp_session', 112, 'worldbook_rp_bind');
        add(['worldbook.list', 'worldbook.read'], 92, 'worldbook_bind_verify');
      } else if (has(/(?:角色卡|人物卡|角色档案|character\s*card|persona|角色世界书)/iu)) {
        add('worldbook.bind_persona', 112, 'worldbook_persona_bind');
        add(['worldbook.list', 'app.resource.read'], 92, 'worldbook_bind_verify');
      } else if (has(/(?:批量|多个|这些|所有|全部|都|分别|每个|多间|多個|sessions?)/iu)) {
        add('worldbook.bind_sessions', 105, 'worldbook_batch_bind');
        add(['worldbook.bind_session', 'worldbook.read'], 92, 'worldbook_bind');
        add('worldbook.list', 106, 'worldbook_bind_prerequisite');
      } else {
        add(['worldbook.bind_session', 'worldbook.list', 'worldbook.read'], 100, 'worldbook_bind');
      }
    }
  }

  if (has(/(?:联网|网上|上网|搜索网页|天气|新闻|最新资讯|官方文档|webview2|web\s*search|image\s*search|参考图|references?)/iu)) {
    add('web.search', 100, 'web_search');
  }
  if (
    hasPositive(/(?:调用|使用).{0,10}(?:生图工具|图片生成工具|media\.generate_image)/iu) ||
    (
      hasPositive(/(?:生成|生图|画)/iu) &&
      has(/(?:图片|图像|头像|壁纸|背景|image)/iu)
    )
  ) {
    add('media.generate_image', 96, 'image_generate');
  }
  if (
    hasPositive(/(?:生成|生图|画).{0,36}(?:聊天室|会话|聊天)?.{0,12}(?:壁纸|背景)/iu)
    || hasPositive(/(?:壁纸|聊天背景).{0,24}(?:生成|生图|画)/iu)
    || hasPositive(/(?:设置|设为|作为|当作|用作|更换).{0,28}(?:壁纸|聊天背景)/iu)
  ) {
    add('session.wallpaper.set', 105, 'generated_wallpaper');
  }
  if (
    hasPositive(/(?:设置|设为|作为|当作|用作|更换).{0,28}(?:联系人|聊天室|会话).{0,12}头像/iu)
    || hasPositive(/(?:联系人|聊天室|会话).{0,12}头像.{0,20}(?:设置|设为|作为|当作|用作|更换)/iu)
  ) {
    add('contact.avatar.set', 105, 'contact_avatar');
  }
  if (has(/(?:格式画像|format\s*profile|output\s*schema|custom\s*output\s*schema)/iu)) {
    add('chat.format.profile', 100, 'format_profile');
  }
  if (has(/(?:格式修复|修复.*格式|格式坏|格式不对|repair.*format)/iu)) {
    add('chat.format.repair', 100, 'format_repair');
  }
  if (has(/(?:优化|润色|精简|更简洁|optimi[sz]e|rewrite)/iu)) {
    add('chat.message.optimize', 100, 'message_optimize');
  }

  if (has(/agent\s*center|agent\s*中心|智能体中心/iu)) {
    add('agent.center.open', 100, 'agent_center');
  }
  if (has(/(?:界面\s*ref|按钮\s*ref|点击|点开|click|按\s*ref|活动.*标签)/iu)) {
    add(['app.visible_panel.read', 'app.ui.click'], 98, 'ui_ref_click');
  }
  if (has(/(?:待办|任务清单|\btodo\b)/iu)) {
    add('maid.todo', 100, 'todo');
  }
  const maidMemoryIntent = /(?:女仆(?:自己)?(?:的)?(?:长期)?记忆|你(?:自己)?记得|你记住|你.{0,12}保存的长期(?:语义)?记忆|你的长期(?:语义)?记忆|长期语义记忆|maid(?:\.|\s*)memory)/iu;
  if (
    maidMemoryIntent.test(text) &&
    /(?:记得什么|记住了什么|列出|查看|看看|哪些|有什么|清单|maid\.memory\.list|\blist\b)/iu.test(text)
  ) {
    add('maid.memory.list', 105, 'maid_memory_list');
  }
  if (
    (
      maidMemoryIntent.test(positiveText) ||
      /(?:清理|归档).{0,12}(?:测试|探针).{0,8}记忆/iu.test(positiveText) ||
      /(?:记忆\s*(?:id)?|maid\.memory).{0,32}(?:归档|archive)|(?:归档|archive).{0,32}(?:记忆\s*(?:id)?|maid\.memory)/iu.test(positiveText)
    ) &&
    /(?:归档|忘掉|忘记|清理|maid\.memory\.archive|archive|forget)/iu.test(positiveText)
  ) {
    add(['maid.memory.archive', 'maid.memory.list'], 108, 'maid_memory_archive');
  }
  const clauseCount = text.split(/(?:[；;。]|然后|最后|接着|随后)/u).map(trim).filter(Boolean).length;
  const quotedTargetCount = (text.match(/「[^」]{1,100}」/gu) || []).length;
  const hasMultiTargetWorkflow = (
    quotedTargetCount >= 3 &&
    /(?:分别|逐(?:一|个|项|房)|每个|多个|三个|这些|全部)/iu.test(text) &&
    /(?:创建|写入|发送|修改|更新|生成|删除|设置|create|write|send|update|generate|delete|set)/iu.test(positiveText) &&
    /(?:读回|核对|验证|清单|状态|最后|完成后|汇报|read|verify|status|list)/iu.test(text)
  );
  if (
    (clauseCount >= 3 || hasMultiTargetWorkflow) &&
    /(?:创建|写入|发送|修改|更新|生成|create|write|send|update|generate)/iu.test(text)
  ) {
    add('maid.todo', 96, 'complex_workflow');
  }

  return Array.from(scores.entries())
    .map(([id, entry]) => ({
      ...available.get(id),
      score: entry.score,
      retrievalReason: 'semantic_concept',
      conceptCodes: Array.from(entry.concepts),
    }))
    .sort((left, right) => right.score - left.score || trim(left.id).localeCompare(trim(right.id)))
    .slice(0, Math.max(1, Math.min(40, Math.trunc(Number(limit) || 20))));
};
