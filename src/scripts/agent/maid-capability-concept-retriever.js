import { hasMaidMediaGenerationIntent } from './maid-app-discovery-recovery.js';

const trim = value => String(value ?? '').trim();

const normalize = value => trim(value)
  .normalize('NFKC')
  .toLowerCase()
  // Template references describe story content; they are not requests to create APP identities.
  .replace(/<\s*(?:user|char)\s*>|\{\{\s*(?:user|char)\s*\}\}/gu, ' ');

const list = value => (Array.isArray(value) ? value : [value]).filter(Boolean);

export const stripNegatedMaidCapabilityActions = value => normalize(value)
  .replace(/(?:不要|不得|禁止|无需|不用|不可|不能|避免|不想|不打算|没让你|(?:暂时?|先)别|不(?=\s*(?:删|执行)))\s*[^，,。；;：:！？!?\n]*/gu, ' ')
  .replace(/(^|[，,。；;：:！？!?\n\s]|请)(?:别|莫)\s*[^，,。；;：:！？!?\n]*/gu, '$1 ');

// Keep destructive-action discovery and its high-risk gate aligned for colloquial requests.
export const hasPositiveMaidDeleteIntent = value =>
  /(?:删除|删掉|删了|移除|清理(?!后)|delete|remove)/iu.test(stripNegatedMaidCapabilityActions(value));

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

  const sessionNoun = /(?:联系人|好友|会话|聊天室|房间|测试房|群聊|群组(?:聊天)?|contacts?|groups?|chats?|conversations?|\bsessions?\b|\brooms?\b)/iu;
  const createIntent = /(?:创建|新建|新增|建立|建\s*(?:一[个间位]?|个|间|位)|\bcreate\b)/iu;
  const addContactIntent = /(?:添加|加)\s*(?:一[个位]?|个|位)?\s*(?:联系人|好友)/iu;
  const listIntent = /(?:列出|读取|查看|清单|名单|所有|全部|哪些|一共有|几间|多少|各几项|列候选|不唯一|inventory|\blist\b|\bevery\b|names?)/iu;
  if (sessionNoun.test(text) && listIntent.test(text)) {
    add('session.list', 98, 'session_inventory');
  }
  if (
    sessionNoun.test(positiveText) &&
    (createIntent.test(positiveText) || addContactIntent.test(positiveText))
  ) {
    add('session.create', 100, 'session_create');
  }
  const contactNoun = /(?:联系人|好友|\bcontacts?\b)/iu;
  const compareIntent = /(?:比较|对比|差异|合并|去重|重复|同名|\bcompar(?:e|ison)\b|\bdiff(?:erences?)?\b|\bmerge\b|\bdedupe\b|\bduplicates?\b)/iu;
  // Comparison guides expose existing reads. A bare merge or unnamed copy
  // does not identify a private resource domain or authorize a write.
  if (contactNoun.test(positiveText) && compareIntent.test(positiveText)) {
    add('session.compare', 112, 'contact_comparison');
  }
  const contactProfileNoun = /(?:档案|画像|人设|资料|年龄|职业|性格|爱好|喜欢|\d+\s*岁|\bprofile\b|\btraits?\b)/iu;
  if (contactNoun.test(positiveText) && contactProfileNoun.test(positiveText)) {
    add('contact_profile.read', 94, 'contact_profile_read');
    add('session.list', 86, 'contact_profile_target');
    if (createIntent.test(positiveText) || addContactIntent.test(positiveText) || /(?:补充|写入|保存|设置|修改|更新|改成|改为|\bupdate\b|\bsave\b)/iu.test(positiveText)) {
      add('contact_profile.upsert', 98, 'contact_profile_write');
    }
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
  const groupChatNoun = /(?:群聊|群组(?:聊天)?|(?:建|拉|开|发起)\s*(?:一[个]?|个)?\s*群(?!众|体)|group\s*chats?|\bgroups?\b)/iu;
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
    /(?:创建|新建|建立|发起|(?:建|拉|开)\s*(?:一[个]?|个)?\s*群|\bcreate\b|\bstart\b)/iu.test(positiveText)
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
  // 从角色卡世界书挑人物建房：卡或世界书、挑人物、聊天去向三者都提到时给出候选，用不用由模型决定
  if (
    /(?:角色卡|人物卡|世界书|character\s*cards?|world\s*books?)/iu.test(text) &&
    /(?:挑|选出|筛选|识别|找出|候选|主要人物|主要角色|核心人物|核心角色|\bpick\b|\bselect\b|\bcandidates?\b|main\s+characters?)/iu.test(text) &&
    /(?:长期聊天|私聊|单聊|聊天室|会话|房间|群聊|群组|联系人|private\s+chats?|chat\s*rooms?|group\s*chats?|contacts?)/iu.test(text)
  ) {
    add('session.character_rooms.plan', 112, 'card_character_rooms');
  }

  if (has(/(?:raworiginal|rendered\s*text|latest\s*assistant|最后一轮\s*ai|末条消息|最近一条消息|局部变量|全局变量|local\s*vars?|global\s*vars?|\bvars?\b|后处理规则|后处理脚本|正规表达式|\bregexp\b|\bregex\b|\bpreset\b|角色皮|角色卡|character\s*cards?|user\s*identit(?:y|ies)|用户名称|当前身份)/iu)) {
    add('app.resource.read', 100, 'structured_resource');
  }
  if (
    hasPositive(/(?:发送|写(?:入)?|发出|send|write).{0,16}(?:消息|message)/iu) ||
    hasPositive(/(?:给|向).{0,80}(?:后台)?写入.{0,80}(?:triggerreply\s*:\s*false|只写不回|open\s*:\s*false)/iu) ||
    // 口语说法：发一条/发个/传讯息、在某聊天室里发、跟某人说一声、转告某人
    hasPositive(/(?:发|传|送)\s*(?:一|几)?\s*(?:条|句|个|段|封)?.{0,12}(?:消息|讯息|信息|私信|短信)/iu) ||
    hasPositive(/(?:在|到|往|去).{0,24}(?:聊天室|私聊|群聊|群里|对话框|房间).{0,12}(?:发|说|讲|回)/iu) ||
    hasPositive(/(?:跟|和|对|向|给)(?!我|你)[^，,。；;！？!?\n]{1,20}?(?:说一声|说句|说一句|说声|讲一声|讲句|打个招呼|问个好|道晚安|道早安|说晚安|说早安)/iu) ||
    hasPositive(/(?:转告|告诉)(?!我|你)[^，,。；;！？!?\n]{1,20}?(?:说|：|:)/iu)
  ) {
    add('chat.send_message', 100, 'chat_send');
  }
  // 改名/改简介（用户、角色卡、聊天室）；提到正则、预设等其他资源时交给对应功能
  if (
    !/(?:正则|规则集|预设|世界书|脚本|设置档|连线|模型|分组|存档|模板|变量|文件)/iu.test(positiveText) && (
      hasPositive(/(?:改名|重命名|更名|rename)/iu) ||
      hasPositive(/(?:名字|名称|用户名|昵称|群名|称呼|简介).{0,12}(?:改成|改为|换成|修改|更改|改一下|变更|更新)/iu) ||
      hasPositive(/(?:修改|更改|变更|改一下|改掉).{0,12}(?:名字|名称|用户名|昵称|群名|称呼|简介)/iu)
    )
  ) {
    add('profile.update', 108, 'profile_rename');
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

  // 预设 / 正则 / 脚本管理：先按名词进入领域，再按动作给出具体工具
  const presetNoun = /(?:预设|系统提示词|上下文模板|指令模板|推理模板|提示词条目|preset|sysprompt)/iu;
  const regexNoun = /(?:正则|正规表达式|替换规则|\bregexp?\b)/iu;
  const scriptNoun = /(?:脚本|酒馆助手|tavern\s*helper|\bscripts?\b)/iu;
  const toggleIntent = /(?:启用|停用|开启|关闭|关掉|打开|禁用|开关|enable|disable|turn\s*(?:on|off))/iu;
  const deleteIntent = /(?:批量删除|删除|删掉|移除|清理(?!后)|delete|remove)/iu;
  const switchIntent = /(?:切换|换成|换用|改用|换个|换一个|用这个|switch|use\s+the)/iu;
  const writeIntent = /(?:新建|新增|添加|加一条|写(?:一条|个)?|创建|修改|改成|改一下|更新|create|add|update|modify)/iu;
  if (presetNoun.test(positiveText)) {
    add('preset.list', 84, 'preset_domain');
    add(['preset.switch', 'preset.prompt_entries.toggle'], 58, 'preset_domain');
    if (/(?:分类|分组|归类|整理|categor|group)/iu.test(positiveText)) add('preset.groups', 108, 'preset_grouping');
    else if (deleteIntent.test(positiveText)) add(['preset.delete_many', 'preset.list'], 106, 'preset_batch_delete');
    else if (/(?:条目|entries?|entry)/iu.test(positiveText) && toggleIntent.test(positiveText)) add(['preset.prompt_entries.toggle', 'preset.list'], 108, 'preset_entry_toggle');
    else if (/(?:复制|拷贝|另存|副本|copy|duplicate)/iu.test(positiveText)) add(['preset.copy', 'preset.list'], 108, 'preset_copy');
    else if (/(?:改名|重命名|名字改|rename)/iu.test(positiveText)) add(['preset.rename', 'preset.list'], 108, 'preset_rename');
    // 参数词只在说到预设时才认（「温度」也可能是天气）
    else if (/(?:温度|temperature|top[\s_-]?[pk]|惩罚|penalty|回复长度|输出长度|最大长度|上下文长度|max[\s_-]?tokens|推理强度|请求推理|流式|stream)/iu.test(positiveText)) {
      if (writeIntent.test(positiveText) || toggleIntent.test(positiveText) || /(?:调|设为|设成|改|降|升|提高|\d)/u.test(positiveText)) add(['preset.params.update', 'preset.read'], 108, 'preset_params');
      else add('preset.read', 100, 'preset_params_read');
    }
    else if (/(?:条目|提示词|entr(?:y|ies)|内容|顺序|排序)/iu.test(positiveText) && (writeIntent.test(positiveText) || /(?:改|移到|放到|挪|排序|顺序)/u.test(positiveText))) {
      add(['preset.prompt_entries.upsert', 'preset.read'], 108, 'preset_entry_edit');
    }
    else if (/(?:内容|写了什么|参数|条目)/u.test(positiveText) && has(/(?:看|查看|有哪些|是多少|读|列出)/u)) add('preset.read', 104, 'preset_read');
    else if (switchIntent.test(positiveText)) add(['preset.switch', 'preset.list'], 106, 'preset_switch');
    else if (has(/(?:有哪些|列出|列表|哪个|哪一个|当前|在用|查看|看看|list|which)/iu)) add('preset.list', 100, 'preset_inventory');
  }
  // 回复被截断：APP 知识里的「防截断传输」（只说明开关位置）
  if (/(?:截断|截掉|写(?:到)?一半(?:就)?(?:断|停)|没写完|(?:回复|正文|输出).{0,6}不完整|中途(?:断|停)|防截断|抗截断|truncat)/iu.test(positiveText)) {
    add('creative.body_tool_transport', 104, 'reply_truncation');
  }
  if (regexNoun.test(positiveText) && !hasPositive(/(?:打开|弹出|show|open).{0,16}(?:正则|regex|regexp).{0,12}(?:面板|页面|panel|editor)/iu)) {
    add('regex.list', 84, 'regex_domain');
    add(['regex.toggle', 'regex.upsert_rules'], 58, 'regex_domain');
    if (deleteIntent.test(positiveText)) add(['regex.delete_many', 'regex.list'], 106, 'regex_delete');
    else if (writeIntent.test(positiveText)) add(['regex.upsert_rules', 'regex.list'], 106, 'regex_write');
    else if (toggleIntent.test(positiveText)) add(['regex.toggle', 'regex.list'], 106, 'regex_toggle');
    else if (has(/(?:有哪些|列出|列表|哪些|查看|看看|list|which)/iu)) add('regex.list', 100, 'regex_inventory');
  }
  // 脚本的总开关与三项权限、新建与改代码、读代码：说到权限／总开关时是设定，说到代码或写、改（不是启停）时是写脚本
  const scriptPermissionIntent = /(?:权限|总开关|全局(?:脚本)?开关|(?:允许|不让|不许)[^，,。；;！？!?\n]{0,10}(?:读|改|修改|访问|联网|上网))/u;
  const scriptSettingIntent = /(?:联网|上网|访问网络|网络访问|脚本功能[^，,。；;！？!?\n]{0,4}(?:开|关)|(?:开|关|启用|停用)[^，,。；;！？!?\n]{0,4}脚本功能)/u;
  const scriptCreateIntent = /(?:新建|新增|创建|添加|写(?:一个|个|一段|段)|做(?:一个|个)|弄(?:一个|个)|\b(?:create|add)\b)/iu;
  const scriptEditIntent = /(?:写(?![了的])|修改|编辑|改|替换|更新|去掉|删掉|删除|加上|加一段|\b(?:edit|update|modify|rewrite)\b)/iu;
  const scriptCodeWords = /(?:代码|源码|\bcode\b)/iu;
  if (scriptNoun.test(positiveText)) {
    add('script.list', 84, 'script_domain');
    add('script.toggle_many', 58, 'script_domain');
    const wantsScriptSettings = scriptPermissionIntent.test(positiveText) || scriptSettingIntent.test(positiveText);
    const wantsScriptWrite = scriptCreateIntent.test(positiveText) || (scriptEditIntent.test(positiveText)
      && (scriptCodeWords.test(positiveText) || (!toggleIntent.test(positiveText) && !scriptPermissionIntent.test(positiveText))));
    // 同一句兼有两种说法（如「写个脚本联网查天气」）时两个都给，由女仆按上下文选
    const scriptWriteScore = wantsScriptSettings && wantsScriptWrite ? 106 : 108;
    if (deleteIntent.test(positiveText) && !scriptCodeWords.test(positiveText)) add(['script.delete_many', 'script.list'], 106, 'script_delete');
    else if (wantsScriptSettings || wantsScriptWrite) {
      if (wantsScriptSettings) add(['script.settings.update', 'script.list'], scriptWriteScore, 'script_settings');
      if (wantsScriptWrite) add(['script.upsert', 'script.read'], scriptWriteScore, 'script_write');
    }
    else if (toggleIntent.test(positiveText) && !/(?:打开|进入|open).{0,6}(?:脚本|script).{0,6}(?:页面|面板|设置|panel|page)/iu.test(positiveText)) add(['script.toggle_many', 'script.list'], 106, 'script_toggle');
    else if (scriptCodeWords.test(positiveText) || /写(?:了|的)什么/u.test(positiveText)) add('script.read', 104, 'script_read');
    else if (has(/(?:有哪些|列出|列表|哪些|查看|看看|list|which)/iu)) add('script.list', 100, 'script_inventory');
  }

  // 插件：查看、启停、从附件或网址安装、移除插件加到界面上的内容；「装了哪些」是查看，不是安装
  if (/(?:插件|\bplugins?\b)/iu.test(positiveText)) {
    add('plugin.list', 84, 'plugin_domain');
    add('plugin.toggle_many', 58, 'plugin_domain');
    const pluginUiWords = /(?:侧边栏|侧栏|卡片|弹窗|界面|\bui\b|sidebar|modal)/iu;
    const pluginInstallIntent = /(?:安装(?!了)|装(?=\s*(?:插件|这|那|一下|上|个|好))|帮我装|导入|更新|升级|\binstall\b|https?:\/\/|github)/iu;
    if (pluginUiWords.test(positiveText) && (deleteIntent.test(positiveText) || /(?:关掉|关闭|去掉|拿掉|收起|清掉)/u.test(positiveText))) add(['plugin.ui.remove', 'plugin.list'], 108, 'plugin_ui_remove');
    else if (pluginInstallIntent.test(positiveText) && !/(?:装了|安装了|有哪些|哪些)/u.test(positiveText)) add(['plugin.install', 'plugin.list'], 108, 'plugin_install');
    else if (toggleIntent.test(positiveText) && !/(?:打开|进入|open).{0,6}(?:插件|plugin).{0,6}(?:页面|面板|设置|panel|page)/iu.test(positiveText)) add(['plugin.toggle_many', 'plugin.list'], 106, 'plugin_toggle');
    else if (pluginUiWords.test(positiveText)) {
      add('plugin.list', 100, 'plugin_ui_read');
      add('plugin.ui.remove', 96, 'plugin_ui_read');
    }
    else if (has(/(?:有哪些|列出|列表|哪些|查看|看看|状态|报错|错误|为什么|list|which)/iu)) add('plugin.list', 100, 'plugin_inventory');
  }

  const profileCreateIntent = /(?:创建|新建|新增|建立|建\s*(?:一[个位]?|个|位)|添加|\bcreate\b)/iu;
  if (
    profileCreateIntent.test(positiveText) &&
    /(?:用户(?:名称|身份|档案)?|\buser\b\s*(?:name|profile|identity)?)/iu.test(positiveText)
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

  const storyCharacterCreate = /(?:新增|添加|新建|创建|补充|加|写)\s*(?:一[个位名]?|个|位|名)?\s*(?:人物|角色(?!卡|档案)|青梅竹马|学妹|学姐|同桌|邻居)/iu.test(positiveText)
    && !/(?:联系人|好友|聊天室|会话|角色卡|人物卡|角色档案|用户档案)/iu.test(positiveText);
  if (storyCharacterCreate) {
    add(['worldbook.list', 'worldbook.read'], 100, 'story_character_target');
    add('worldbook.create', 98, 'story_character_create');
    add('app.resource.read', 90, 'story_character_context');
  }
  const inferredWorldbookContentIntent = /(?:读取|查看|核对).{0,80}(?:资料|设定).{0,40}(?:人物|角色).{0,24}(?:地点|事件|世界观)/iu;
  const worldbookIntent = /(?:世界书|世借书|world\s*book|worldbook|world\s*lore|lore\s*library|条目|entry\s*titles?|目录页|(?:replace|覆盖).{0,24}全部内容)/iu;
  if (/(?:世界书|世借书|\bworld\s*books?\b|\bworld\s*lore\b|\blore\s*library\b)/iu.test(positiveText)
    && compareIntent.test(positiveText)) {
    add('worldbook.compare', 112, 'worldbook_comparison');
  }
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
    if (hasPositiveMaidDeleteIntent(text) || hasPositive(/(?:去重|dedupe)/iu)) {
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
    hasMaidMediaGenerationIntent(positiveText) ||
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
  // Agent Center 里的 Agent（回复 Agent 如正文润色、输入助手、格式修复与文本建议的开关和模型）与小管家。
  // 「润色这条回复」是一次性的 chat.message.optimize；说到每次／自动／回复后再调用模型，或 Agent／工作流时才是设定 Agent。
  const agentNoun = /(?:正文润色|回复\s*agent|润色\s*agent|输入助手|(?:\bagent\b|智能体).{0,6}(?:设定|设置|配置|模型|开关|提示词)|(?:有哪些|哪些|列出|查看|看看).{0,6}(?:\bagent\b|智能体)|工作流|润色流程)/iu;
  const everyReplyEdit = /(?:每次|每条|每轮|每一轮|自动|以后都|之后都).{0,16}(?:润色|编修|修改|改写|优化|校对)|(?:润色|编修|改写|校对).{0,12}(?:每次|每条|每轮|自动)|(?:生成|回复|正文).{0,8}(?:结束|完成|生成完|之后|后).{0,16}(?:调用|用).{0,10}(?:模型|ai)/iu;
  const builtinAgentNoun = /(?:格式修复|文本建议|输入建议)/iu;
  const agentConfigIntent = /(?:开启|启用|打开|关闭|关掉|停用|模型|换成|改成|设定|设置|配置|enable|disable)/iu;
  const buildIntent = /(?:做一个|弄一个|帮我做|建一个|搞一个|加一个)/u;
  if (agentNoun.test(positiveText) || everyReplyEdit.test(positiveText) || (builtinAgentNoun.test(positiveText) && agentConfigIntent.test(positiveText))) {
    add('agent.list', 84, 'agent_domain');
    add('agent.upsert', 58, 'agent_domain');
    if (deleteIntent.test(positiveText)) add(['agent.delete_many', 'agent.list'], 106, 'agent_delete');
    else if (writeIntent.test(positiveText) || toggleIntent.test(positiveText) || agentConfigIntent.test(positiveText) || everyReplyEdit.test(positiveText) || buildIntent.test(positiveText)) {
      add(['agent.upsert', 'agent.list'], 108, 'agent_write');
    } else if (has(/(?:有哪些|列出|列表|哪些|查看|看看|list|which)/iu)) add('agent.list', 100, 'agent_inventory');
  }
  if (/(?:小管家|存档命名|存档概述|消息翻译|贴图起名|生图描述转英文标签|steward)/iu.test(positiveText)) {
    add('agent.list', 84, 'steward_domain');
    if (writeIntent.test(positiveText) || toggleIntent.test(positiveText) || agentConfigIntent.test(positiveText) || deleteIntent.test(positiveText) || buildIntent.test(positiveText)) {
      add(['steward.configure', 'agent.list'], 108, 'steward_write');
    } else add('agent.list', 100, 'steward_inventory');
  }
  // 流程板（跳房子）：查看与调整房子；自定义板上只有放上板的回复 Agent 会在回复后执行
  if (/(?:跳房子|流程板|编排板|流程里|流程中|hopscotch)/iu.test(positiveText) || /放(?:进|到|上).{0,6}(?:流程|板)/u.test(positiveText)) {
    add('flow.read', 86, 'flow_domain');
    if (writeIntent.test(positiveText) || toggleIntent.test(positiveText) || deleteIntent.test(positiveText)
      || /(?:放进|放到|放上|加到|加进|移到|移掉|移除|排序|调整|改回|跟随)/u.test(positiveText)) {
      add(['flow.update', 'flow.read'], 108, 'flow_write');
    } else add('flow.read', 100, 'flow_inventory');
  }
  // 变量的设值与删除（读现值用 app.resource.read 的 variables）；变量规则另有面板，不在这里
  if (/(?:变量|variables?|\bmvu\b)/iu.test(positiveText) && !/规则/u.test(positiveText)) {
    if (deleteIntent.test(positiveText)) add(['variable.delete', 'app.resource.read'], 108, 'variable_delete');
    else if (writeIntent.test(positiveText) || /(?:改成|改为|设为|设成|调成|调到|加到|减到|增加|减少)/u.test(positiveText)) add(['variable.set', 'app.resource.read'], 108, 'variable_set');
  }
  // 记忆表格的行与记忆设定
  const memorySettingWords = /(?:注入位置|注入深度|预算|共享|带进|自动写入)/u;
  const memoryTableToggle = /(?:开启|关闭|关掉|打开|启用|停用).{0,6}记忆表格/u;
  if (/(?:记忆表格|记忆表|memory\s*tables?)/iu.test(positiveText) && !memorySettingWords.test(positiveText) && !memoryTableToggle.test(positiveText)) {
    add('memory.rows.read', 86, 'memory_rows_domain');
    if (deleteIntent.test(positiveText)) add(['memory.rows.delete', 'memory.rows.read'], 108, 'memory_rows_delete');
    else if (writeIntent.test(positiveText) || /(?:改成|改为|补上|加一行|新增一行|修正)/u.test(positiveText)) add(['memory.rows.upsert', 'memory.rows.read'], 108, 'memory_rows_write');
    else add('memory.rows.read', 100, 'memory_rows_read');
  } else if (/记忆/u.test(positiveText) && (memorySettingWords.test(positiveText) || memoryTableToggle.test(positiveText) || /记忆.{0,6}(?:设定|设置)/u.test(positiveText))) {
    add('memory.settings.read', 86, 'memory_settings_domain');
    if (writeIntent.test(positiveText) || toggleIntent.test(positiveText) || /(?:改成|改为|设为|调成|调大|调小)/u.test(positiveText)) add(['memory.settings.update', 'memory.settings.read'], 108, 'memory_settings_write');
    else add('memory.settings.read', 100, 'memory_settings_read');
  }
  if (has(/(?:界面\s*ref|按钮\s*ref|点击|点开|click|按\s*ref|活动.*标签)/iu)) {
    add(['app.visible_panel.read', 'app.ui.click'], 98, 'ui_ref_click');
  }
  if (has(/(?:待办|任务清单|\btodo\b)/iu)) {
    add('maid.todo', 100, 'todo');
  }
  // 新手引导：提到新手、教程，或要人一步步教
  if (has(/(?:新手|教程|教学|上手|一步步|一步一步|手把手|教我|指导我)/u)) {
    add('maid.onboarding', 100, 'onboarding');
  }
  // 明说要随机才交给随机互动（选项常夹在中间，整词别名对不上）；只问哪个好是要建议，不算
  if (
    hasPositive(/(?:随便|随机|抓阄|帮我决定)/u) &&
    hasPositive(/(?:选|挑|抽|决定|还是|二选一)/u)
  ) {
    add('maid.random', 100, 'random_choice');
  }
  // 现实中的地点或路线：明说地图，或问怎么去／怎么走（APP 里的「地图」类功能另有关系图、血缘图，不含「地图」二字）
  if (hasPositive(/(?:地图|google\s*maps?|谷歌地图|高德|怎么去|怎么走|怎么到|导航(?:到|去)|带我去|路线(?:规划)?)/iu)) {
    add('maid.map', 100, 'map_place');
  }
  // 现实天气（「温度」不算：常指模型参数）
  if (hasPositive(/(?:天气|气温|下雨|下雪|带伞|冷不冷|热不热|weather|forecast)/iu)) {
    add('maid.weather', 100, 'weather');
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
