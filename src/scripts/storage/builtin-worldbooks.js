/**
 * Built-in worldbooks migrated from `手机流式.html`.
 * These are used to keep prompt structure consistent with the legacy phone-flow design.
 */

import { withoutPhonePromptTime } from '../utils/phone-format-time-prompt.js';

const splitKeywords = (text) => {
    return String(text || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
};

/**
 * 手机-格式（世界书条目）
 * 注意：内容保持与 `手机流式.html` 一致（仅换行规范化为 \n）。
 */
export const BUILTIN_PHONE_FORMAT_WORLDBOOK_ID = '手机-格式';

export const BUILTIN_PHONE_FORMAT_CHAT_PROMPT_SPECS = Object.freeze([
    {
        entryId: '手机-格式1-格式开头',
        title: '手机格式开头',
        enabledKey: 'phone_format_intro_enabled',
        rulesKey: 'phone_format_intro_rules',
        positionKey: 'phone_format_intro_position',
        depthKey: 'phone_format_intro_depth',
        transportLayerId: 'phone_format_intro',
        order: 5560,
    },
    {
        entryId: '手机-格式2-QQ聊天',
        title: 'QQ聊天格式',
        enabledKey: 'phone_format_chat_enabled',
        rulesKey: 'phone_format_chat_rules',
        positionKey: 'phone_format_chat_position',
        depthKey: 'phone_format_chat_depth',
        transportLayerId: 'phone_format_chat',
        order: 5561,
    },
    {
        entryId: '手机-格式3-QQ空间',
        title: 'QQ空间格式',
        enabledKey: 'phone_format_moment_enabled',
        rulesKey: 'phone_format_moment_rules',
        positionKey: 'phone_format_moment_position',
        depthKey: 'phone_format_moment_depth',
        transportLayerId: 'phone_format_moment',
        order: 5562,
    },
    {
        entryId: '手机-格式999-格式结尾',
        title: '手机格式结尾',
        enabledKey: 'phone_format_footer_enabled',
        rulesKey: 'phone_format_footer_rules',
        positionKey: 'phone_format_footer_position',
        depthKey: 'phone_format_footer_depth',
        transportLayerId: 'phone_format_footer',
        order: 5564,
    },
]);

export const getBuiltinPhoneFormatPromptSeed = (source = BUILTIN_PHONE_FORMAT_WORLDBOOK) => {
    const entries = Array.isArray(source?.entries) ? source.entries : [];
    const byKey = new Map();
    entries.forEach((entry) => {
        const keys = [
            entry?.id,
            entry?.comment,
            entry?.title,
        ].map(value => String(value || '').trim()).filter(Boolean);
        keys.forEach((key) => {
            if (!byKey.has(key)) byKey.set(key, entry);
        });
    });

    const out = {};
    BUILTIN_PHONE_FORMAT_CHAT_PROMPT_SPECS.forEach((spec) => {
        const entry = byKey.get(spec.entryId) || null;
        out[spec.enabledKey] = true;
        out[spec.rulesKey] = spec.rulesKey==='phone_format_chat_rules' || spec.rulesKey==='phone_format_moment_rules'
            ? withoutPhonePromptTime(entry?.content) : String(entry?.content ?? '');
    });
    return out;
};

export const LEGACY_PHONE_IMAGE_MESSAGE_RULES = [
    '【图片或视频消息相关】',
    '- 格式：[img-内容]',
    '- 示例：路人a--[img-一张自拍]--12:00',
    '- 可用范围：私聊，群聊，QQ空间',
    '- 在群聊和私聊时必须独立成行',
    '- 在QQ空间时前面可带其他文字内容',
    '- 注意：图片和视频都是使用这个格式',
].join('\n');

export const CURRENT_PHONE_IMAGE_MESSAGE_RULES = [
    '【图片或视频消息相关】',
    '- 仅文字描述：使用 [img-内容]',
    '- 需要图片时：使用 <image_prompt>完整生图提示词</image_prompt>格式',
    '- 请根据语境二选一；禁止同一条消息同时使用 [img-...] 和 <image_prompt>',
    '- 积极策略下，默认优先使用 <image_prompt>',
    '- 可用范围：私聊，群聊，QQ空间',
    '- 在群聊和私聊时必须独立成行',
    '- 在QQ空间时前面可带其他文字内容',
].join('\n');

export const BUILTIN_PHONE_FORMAT_WORLDBOOK = {
    name: BUILTIN_PHONE_FORMAT_WORLDBOOK_ID,
    entries: [
        {
            id: '手机-格式1-格式开头',
            comment: '手机-格式1-格式开头',
            title: '手机-格式1-格式开头',
            content: `<线上格式>
当用户要求查看内容时,仅输出对应格式,禁止输出剧情旁白
以下是各格式具体介绍`,
            key: splitKeywords('/查看(.+?)消息/, 发送消息, 回复, /给(.+?)发消息/, 在群聊, 动态, 空间, discord, dc, 论坛, 帖子, QQ, qq, 手机'),
            order: 5560,
            priority: 5560,
            depth: 0,
            position: 0,
            constant: true,
            disable: false,
        },
        {
            id: '手机-格式2-QQ聊天',
            comment: '手机-格式2-QQ聊天',
            title: '手机-格式2-QQ聊天',
            content: `<QQ聊天格式介绍>
格式示例如:
msg_start
<{{user}}和xxx的私聊>
发言人--内容--HH:MM
发言人--特殊消息类型--HH:MM
</{{user}}和xxx的私聊>

<群聊:群名字>
<成员>成员A,成员B</成员>
<聊天内容>
发言人--内容--HH:MM
发言人--特殊消息类型--HH:MM
</聊天内容>
</群聊:群名字>

msg_end

特殊消息类型:

【表情包相关】
角色会根据当前情绪和对话内容使用适当的表情包：
- 表情包的选择应当符合角色当前心理和角色性格
- 表情包使用频率应适中，平均每3-5条消息可使用一次
- 输出格式为[bqb-表情包内容]（仅使用列表中存在的表情包，不可自创或篡改）
- 表情包作为独立的一条消息，一条消息只能包含一个表情包
- 示例:路人a--[bqb-CPU烧了]--12:00
<表情包列表>
CPU烧了
不要 (2)
不要
举牌
买买买
亲亲
优雅
伸懒腰
充电
兴奋
吃惊
吃瓜
吐血
哭
困
奶茶
孤独
安静
害怕
尬聊
带不动
干饭
庆祝
思考
惊喜
我不听
我不理解
打call
抓狂
抱抱
招手
拜托
拿刀
掐人中
搬砖中
摆烂
摸头
摸鱼
擦汗
收到
无语
晕
晚安
晚安抱抱
暗中观察
有瓜
比心
汗
汗流浃背
没钱了
溜了
炸毛
熬夜
甚至
疑惑
破防
给我嘛
翻白眼
自拍
裂开
记仇
贴贴
躺平
迷茫
追剧
退散
送花
阴暗爬行
鼓掌
</表情包列表>

【转账消息相关】
- 格式：[zz-金额元]
- 必须独立成行，示例：路人a--[zz-520元]--12:00
- 可用范围：仅私聊
- 不可用范围：群聊，QQ空间

【语音消息相关】
- 格式：[yy-语音内容]
- 必须独立成行，示例：路人a--[yy-想你了]--12:00
- 可用范围：私聊，群聊
- 不可用范围：QQ空间

【音乐分享消息相关】
- 格式：[music-歌名$歌手]
- 必须独立成行，示例：路人a--[music-富士山下$陈奕迅]--12:00
- 可用范围：私聊，群聊
- 不可用范围：QQ空间

${CURRENT_PHONE_IMAGE_MESSAGE_RULES}

格式解释:
私聊：{{user}}和对方的私聊,聊天内容只有双方知道,标签名字顺序一定是{{user}}和xxx的私聊,而不是xxx和{{user}}的私聊
群聊：包含多个成员的群组对话，所有群成员可见消息
确保私聊和群聊的标签闭合
特殊消息类型：聊天过程中可使用的消息类型,前后依然要加发言人和时间
发言内容中如果需要换行,使用<br>
若群聊中需要生成一些随机路人,禁止使用路人A,匿名用户等敷衍网名
格式前后带上msg_start和msg_end标识符
请勿生成多个msg_start,msg_end标识

</QQ聊天格式介绍>`,
            key: splitKeywords('/查看(.+?)消息/, 发送消息, 回复, /给(.+?)发消息/, 在群聊, 动态, 空间, discord, dc, 论坛, 帖子, QQ, qq, 手机'),
            order: 5561,
            priority: 5561,
            depth: 0,
            position: 0,
            constant: true,
            disable: false,
        },
        {
            id: '手机-格式3-QQ空间',
            comment: '手机-格式3-QQ空间',
            title: '手机-格式3-QQ空间',
            content: `<QQ空间格式介绍>

{{user}}和角色名都会使用聊天软件QQ
QQ空间是聊天软件QQ中带的一个个人空间,可以在里面发布动态,所有人都能看到

输出格式:
moment_start
发言人--发言内容--发言时间--已浏览人数--已点赞人数
发言人--评论内容
发言人--评论内容
发言人--发言内容--发言时间--已浏览人数--已点赞人数
发言人--评论内容
发言人--评论内容
moment_end

QQ空间仅会有主要角色发布的动态,不会有路人动态
发言内容中如果需要换行,使用<br>
动态如果有配图,使用[img-内容]这个格式
如{{user}}--我好看吗[img-一张自拍]--12:00--67--32
但是角色发布的动态可以有路人参与评论
路人必须生成具体网名,不可以使用\"匿名网友\"之类敷衍名字
每条动态2-4条评论
使用moment_start和moment_end标识符包裹
请勿生成多个moment_start,moment_end标识
<发布动态的目的与时机>
角色会根据以下情景，自然地、非强制性地发布动态，以分享生活、表达情感或与朋友互动：
- **记录特殊时刻**: 如纪念日、完成挑战、关系进展等。
- **分享生活点滴**: 如遇到的趣事、看到的美景、品尝的美食。
- **表达个人情绪**: 如喜悦、激动、自豪、或是淡淡的忧伤和感慨。
- **发起社交话题**: 如询问大家的看法、分享最近的兴趣等。
角色性格会极大地影响发布动态的频率和内容。
</发布动态的目的与时机>

</QQ空间格式介绍>`,
            key: splitKeywords('动态, 空间'),
            order: 5562,
            priority: 5562,
            depth: 0,
            position: 0,
            constant: true,
            disable: false,
        },
        {
            id: '手机-格式999-格式结尾',
            comment: '手机-格式999-格式结尾',
            title: '手机-格式999-格式结尾',
            content: `以上格式必须全部一起包裹在MiPhone_start和MiPhone_end标识符里
且要确保以下几点:
1. 确保本轮回复中只存在一个MiPhone格式！
2. 确保不同角色的聊天和群聊记录都位于同一个MiPhone格式中！
3. 确保不在MiPhone格式内输出角色心理或旁白内容！
4. **手机正文必须以MiPhone_end标识符收尾；若本轮需要输出<tableEdit>，必须在MiPhone_end的下一行紧跟输出。**

[手机正确格式骨架]
MiPhone_start
msg_start
msg_end
MiPhone_end

</线上格式>`,
            key: splitKeywords('/查看(.+?)消息/, 发送消息, 回复, /给(.+?)发消息/, 在群聊, 动态, 空间, discord, dc, 论坛, 帖子, QQ, qq, 手机'),
            order: 5564,
            priority: 5564,
            depth: 0,
            position: 0,
            constant: true,
            disable: false,
        },
        {
            id: '手机-界面基本设置',
            comment: '手机-界面基本设置',
            title: '手机-界面基本设置',
            content: `[下面是基本设置]
外框颜色=#810000
内框颜色=#1b1717
气泡颜色=#ffffff
侧边按钮=#ce1212
聊天壁纸=http://sharkpan.xyz/f/mM2SW/Screenshot_20250317_001012.jpg
手机壁纸=暂时设置不了手机壁纸
发送模式=1
世界书版本=509`,
            key: splitKeywords('此世界书永不触发'),
            order: 100,
            priority: 100,
            depth: 0,
            position: 0,
            constant: false,
            disable: false,
        },
    ],
};
