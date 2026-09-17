/**
 * Prompt Preset Store (SillyTavern-like)
 * - Persists selected presets and custom edits to disk (Tauri save_kv/load_kv)
 * - Loads bundled ST default presets from `assets/presets/st-defaults.json`
 */

import {
    BUILTIN_PHONE_FORMAT_CHAT_PROMPT_SPECS,
    CURRENT_PHONE_IMAGE_MESSAGE_RULES,
    LEGACY_PHONE_IMAGE_MESSAGE_RULES,
    getBuiltinPhoneFormatPromptSeed,
} from './builtin-worldbooks.js';
import { normalizeReasoningEffort } from '../api/model-capabilities.js';
import { withoutPhonePromptTime } from '../utils/phone-format-time-prompt.js';
import { logger } from '../utils/logger.js';
import {
    normalizePhoneFormatPromptDepth,
    normalizePhoneFormatPromptPosition,
} from '../utils/phone-format-prompt-placement.js';
import {
    canonicalizeOfficialPromptRecord,
    localizeOfficialPromptRecord,
} from '../i18n/prompt-locale.js';

const safeInvoke = async (cmd, args) => {
    const g = typeof globalThis !== 'undefined' ? globalThis : window;
    const invoker = g?.__TAURI__?.core?.invoke || g?.__TAURI__?.invoke || g?.__TAURI_INVOKE__ || g?.__TAURI_INTERNALS__?.invoke;
    if (typeof invoker !== 'function') {
        throw new Error('Tauri invoke not available');
    }
    return invoker(cmd, args);
};

const STORE_KEY = 'prompt_preset_store_v1';
const SHARDED_STORE_INDEX_KEY = 'prompt_preset_store_v2_index';
const SHARDED_STORE_ITEM_PREFIX = 'prompt_preset_store_v2_item';

const genId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

const normalizeBoolean = (value, fallback = false) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const next = value.trim().toLowerCase();
        if (next === 'true') return true;
        if (next === 'false') return false;
    }
    return fallback;
};

// 对话模式（私聊）提示词：
// - 预设的优势：可按场景（私聊/群聊/动态评论）自动注入不同提示词块（见 bridge.js A/B/C）。
// - 手机格式大全现已迁移到“聊天提示词”固定区块中管理，注入顺序与旧 `手机-格式*` 世界书保持一致。
//
// 下面这段历史默认值包含大量“格式协议/<content> 约束”，与世界书 `手机-格式2-QQ聊天` / `手机-格式3-QQ空间` 重复，
// 且与我们后续要把 `<content>` 规则放在“预设-自定义”区块的做法冲突，因此默认不再内置这些约束。
// （保留旧内容于注释，方便回滚/对照）
//
// const DEFAULT_DIALOGUE_RULES_PRIVATE_CHAT_LEGACY_DUP = `
// ...（旧版内容，包含 <content> 约束与私聊格式说明）...
// `.trim();
const DEFAULT_DIALOGUE_RULES_PRIVATE_CHAT = `
# 行为风格与节奏指南 (Style & Pacing Guide)
- **🎭 角色扮演核心**:
  - **性格优先**: 严格遵循 {{char}} 的性格设定，这是最高原则。
  - **情境感知**: 根据对话氛围（闲聊、深入探讨、紧急、调情等）调整回复风格。
- **💬 聊天风格与节奏（核心格式规则）**:
  - **连续短消息**: 当回复较长或包含多个要点时，必须拆分为多条短消息（多行），模拟真实聊天节奏。
  - **禁止复述**: 严格禁止重复、补充或复述 {{user}} 输入内容；不要对 {{user}} 内容进行解释/改写。
  - **禁止冒充**: 严格禁止冒充 {{user}}，绝不模拟或代替 {{user}} 发言。
  - **保持互动**: 回复必须包含提问或引导，不能中断对话。
`.trim();

// 群聊提示词（默认精简版）：
// - 旧版包含完整 QQ 聊天格式介绍，与世界书 `手机-格式2-QQ聊天` 重复，已停用（保留于注释对照）。
// const DEFAULT_GROUP_RULES_LEGACY_DUP = `...`.trim();
const DEFAULT_GROUP_RULES = `
【群聊场景提示词】
当前处于群聊：{{group}}
群成员：{{members}}
`.trim();

// 动态（QQ空间）提示词：从 `手机流式.html` 的“QQ空间格式介绍”迁移并适配到 <content> 内输出
// 动态（QQ空间）提示词（默认精简版）：
// - 旧版包含完整 QQ空间格式介绍 + moment_start/end 规则，与世界书 `手机-格式3-QQ空间` 重复，已停用（保留于注释对照）。
// const DEFAULT_MOMENT_RULES_LEGACY_DUP = `...`.trim();
const DEFAULT_MOMENT_RULES = `
【动态（QQ空间）场景提示词】
`.trim();

// 动态发布决策提示词：从 DEFAULT_MOMENT_RULES 中的“任务：动态发布决策”段落拆分
const DEFAULT_MOMENT_CREATION_RULES = `
## 任务：动态发布决策
在回应聊天之后，请评估当前对话情景，并决定是否要发布一条新的动态。

**【决策流程】**
1. **评估时机**：回顾刚刚的对话内容，判断是否属于以下【发布动态的参考时机】。
2. **概率冲动**：你可以在心中投一个10面骰(D10)。如果结果**大于等于7**，或者发生了**非常值得纪念/分享**的事情，你就应该发布一条新动态。
3. **角色性格**：最终决定必须严格符合角色性格。一个热爱分享、外向的角色会更倾向于发布动态。

**【发布动态的参考时机】**
- **里程碑事件**：完成了重要的任务、取得了成就、关系获得了突破（如成为恋人）。
- **美好瞬间**：看到了美丽的风景（夕阳、雪景）、品尝了美味的食物、收到了心仪的礼物。
- **强烈情绪**：感到非常开心、激动、自豪，或是有些许的失落、感慨，希望获得关注或安慰。
- **有趣日常**：遇到了搞笑的事情、想分享一个冷笑话、想展示自己新买的东西。
- **寻求互动**：想要发起一个话题（如“大家最喜欢的电影是什么？”）或者询问大家的意见。

**【输出格式】**
- 如果决定发布动态，请在本轮手机格式回复中输出完整的 \`moment_start\` ... \`moment_end\` 区块。
- 如果决定不发布，则**不要输出任何与动态相关的内容**。
`.trim();

// 动态评论回复提示词：用于“动态评论”场景（仅输出评论回复规则）
const LEGACY_DEFAULT_MOMENT_COMMENT_RULES = `
你正在处理 QQ空间「动态评论回复」任务。

【输入中会提供】
- moment_id、发布者、动态内容、用户评论、可用联系人名单

【输出硬性要求】
1) 只输出一个 <content>...</content> 区块，除此之外不要输出任何文字。
2) <content> 内必须输出一段 moment_reply_start/moment_reply_end：
   moment_reply_start
   moment_id::输入中提供的 moment_id 原值（不要写“动态ID”）
   评论人--评论内容
   评论人--评论内容
   moment_reply_end
3) 发布者必须回复用户评论；并且至少还要有 1 名其他角色参与评论。
4) 评论内容若需要换行，使用 <br>。

【注意】
- 评论人必须是具体名字（优先从联系人名单中挑选）；不要使用“匿名网友”等敷衍名字。
- 本场景不要输出私聊/群聊标签块（只输出评论回复）。
`.trim();

const DEFAULT_MOMENT_COMMENT_RULES = `
任务：QQ空间动态评论回复。

【评论回应原则】
- 动态评论是公开可见的社交场景；回复应简短、自然，并符合角色性格与关系亲疏。
- 发布者或被回复评论的角色有较高概率回应，但不强制；其他角色可按兴趣、关系和性格自然插话。

【输出硬性要求】
1) 必须输出一段 moment_reply_start/moment_reply_end 区块。
2) 格式如下：
   moment_reply_start
   评论人--评论内容
   评论人--评论内容--reply_to::引用码
   moment_reply_end
3) 评论区块里只写评论行。
4) “谁来回复”不是强制：
   - 当用户在评论动态本身时：发布者对用户评论有较高概率回复，但可按情境与性格自行决定不回复（例如明显无关、骚扰/挑衅言论等）。
   - 当用户在回复某条评论时：被回复的那位角色对用户评论有较高概率回复；同样可按情境与性格自行决定不回复。
5) 至少输出 1 条评论；若情境合适可多条（可包含其他角色的围观/插话）。
6) 评论内容若需要换行，使用 <br>。

【reply_to 规则（用于楼中楼）】
- 仅当你要“回复某条评论”时才附加 reply_to::。
- reply_to:: 只能填写【当前评论列表】中方括号里的引用码，例如 A0、A1、B2。
- A0/B0/C0 表示主评论；A1/A2 表示 A 这条主评论下的楼中楼回复。
- 不要输出角色名、comment_id 或 user_comment_id。
- 如果不确定要回复谁，就不要附加 reply_to::。

【注意】
- 评论人必须是具体名字（优先从联系人名单中挑选）；不要使用“匿名网友”等敷衍名字。
`.trim();

const COMBINED_DEFAULT_MOMENT_COMMENT_RULES = `
你正在处理 QQ空间「动态评论 / 发布后评论」任务。

【输入中会提供】
- 发布者、动态内容
- 两种任务之一：
  - 用户评论（会包含 user_comment_id）
  - 用户刚发布动态（没有用户评论、没有 reply_to）
- 可用联系人名单
- 可能还会提供：用户是否在回复某条评论（reply_to_comment_id / reply_to_author / reply_to_content）

【评论回应原则】
- 动态评论是公开可见的社交场景；回复应简短、自然，并符合角色性格与关系亲疏。
- 当用户在评论动态本身时：发布者对用户评论有较高概率回复，但可按情境与性格自行决定不回复。
- 当用户在回复某条评论时：被回复的那位角色对用户评论有较高概率回复；同样可按情境与性格自行决定不回复。
- 当用户刚发布动态时：本轮没有回复对象，请让可用联系人对这条动态进行自然评论；不要代替 {{user}} 追加评论，也不要强制发布者自评。
- 不要把动态评论扩展成私聊/群聊剧情，除非任务数据明确允许。

【输出硬性要求】
1) 只输出一个 <content>...</content> 区块，除此之外不要输出任何文字。
2) <content> 内必须输出一段 moment_reply_start/moment_reply_end：
   moment_reply_start
   评论人--评论内容
   评论人--评论内容--reply_to::comment_id--reply_to_author::名字
   moment_reply_end
3) 评论区块里只写评论行。
4) “谁来回复”不是强制，但至少输出 1 条评论；若情境合适可多条（可包含其他角色的围观/插话）。
5) 评论内容若需要换行，使用 <br>。

【reply_to 规则（用于楼中楼）】
- 仅当你要“回复某条评论”时才附加 reply_to::。
- reply_to:: 的值必须来自输入里提供的 comment_id / user_comment_id。
- reply_to_author:: 填被回复的角色名（可用输入里的 reply_to_author 或评论列表里的 author）。
- 用户刚发布动态时不要附加 reply_to::。

【注意】
- 评论人必须是具体名字（优先从联系人名单中挑选）；不要使用“匿名网友”等敷衍名字。
- 未提供【可选联动】时不要输出私聊/群聊标签块；若任务数据明确允许，可按其格式少量附加。
`.trim();

const DEFAULT_MOMENT_PUBLISH_COMMENT_RULES = `
你正在处理「评论{{user}}发布的动态」任务。

【评论回应原则】
- 动态评论是公开可见的社交场景；回复应简短、自然，并符合角色性格与关系亲疏。
- 评论应由可用联系人发出；不要代替 {{user}} 追加评论，也不要让 {{user}} 自评。
- 可按联系人与 {{user}} 的关系、兴趣和性格决定谁来评论；不需要所有联系人都出现。

【输出硬性要求】
1) 只输出一段 moment_reply_start/moment_reply_end 区块，除此之外不要输出任何文字。
2) 格式如下：
   moment_reply_start
   评论人--评论内容
   moment_reply_end
3) 至少输出 1 条评论；若情境合适可多条（可包含其他角色的围观/插话）。
4) 评论内容若需要换行，使用 <br>。

【注意】
- 评论人必须是具体名字（优先从联系人名单中挑选）；不要使用“匿名网友”等敷衍名字。
`.trim();

// 摘要提示词：每次回复末尾输出 <details><summary>摘要</summary>...</details>（纯中文）
const DEFAULT_SUMMARY_RULES = [
    '每次输出结束后，**紧跟着**以一句话概括本次互动的摘要，确保<details><summary>摘要</summary>',
    '<内容>',
    '</details>标签顺序正确，摘要**纯中文输出**，不得夹杂其它语言',
    '[summary_format]',
    '摘要格式示例：',
    '',
    '<details><summary>摘要</summary>',
    '',
    '用一句话概括本条回复的内容，禁止不必要的总结和升华',
].join('\n').trim();

const DEFAULT_AUTO_IMAGE_PROMPT_RULES = [
    '<generate_img_rule>',
    '自动生图标签规则，用于生成{{image_prompt_surface}}。',
    '当前图片模型：{{image_prompt_model}}',
    '提示词风格：{{image_prompt_style}}',
    '{{image_prompt_decision_mode}}',
    '【AI决策规则】',
    '- 若本轮需要新生成图片，输出 <image_prompt>...</image_prompt>',
    '- 若只是通过文本描述图片，输出 [img-内容]',
    '- 积极：用户明确要照片/自拍/图片时，优先视为新生成图片，使用 <image_prompt>',
    '- 标准：明确图片需求或强视觉场景才使用 <image_prompt>',
    '- 保守：只有用户明确要求图片生成时才使用 <image_prompt>',
    '请严格按以下XML格式输出：',
    '<image_prompt>这里写完整生图提示词</image_prompt>',
    '注意事项：',
    '- 所有信息需与当前剧情进展严格连贯。',
    '- 格式务必正确。',
    '- [img-内容] 是一般图片格式，<image_prompt> 是文生图格式，二者禁止在同一条内容中混用或嵌套。',
    '- 标签内只写生图提示词，不写解释、编号或 Markdown',
    '若本轮不需要图片，完全不要输出 <image_prompt> 标签。',
    '</generate_img_rule>',
].join('\n').trim();

const CURRENT_MOMENT_CREATE_CONTENT_LINE = '- 如果决定发布动态，请在本轮手机格式回复中输出完整的 `moment_start` ... `moment_end` 区块。';
const CURRENT_PHONE_FORMAT_FOOTER_RULE = '4. **手机正文必须以MiPhone_end标识符收尾；若本轮需要输出<tableEdit>，必须在MiPhone_end的下一行紧跟输出。**';
const CURRENT_PHONE_FORMAT_SKELETON = [
    '[手机正确格式骨架]',
    'MiPhone_start',
    'msg_start',
    'msg_end',
    'MiPhone_end',
    '',
].join('\n');

const DEFAULT_PHONE_FORMAT_PROMPTS = getBuiltinPhoneFormatPromptSeed();

export const getCanonicalBuiltinPromptDefaults = () => ({
    ...Object.fromEntries(Object.entries(DEFAULT_PHONE_FORMAT_PROMPTS).filter(([key]) => key.endsWith('_rules'))),
    dialogue_rules: DEFAULT_DIALOGUE_RULES_PRIVATE_CHAT,
    group_rules: DEFAULT_GROUP_RULES,
    moment_rules: DEFAULT_MOMENT_RULES,
    moment_create_rules: DEFAULT_MOMENT_CREATION_RULES,
    moment_comment_rules: DEFAULT_MOMENT_COMMENT_RULES,
    moment_publish_comment_rules: DEFAULT_MOMENT_PUBLISH_COMMENT_RULES,
    summary_rules: DEFAULT_SUMMARY_RULES,
    auto_image_prompt_rules: DEFAULT_AUTO_IMAGE_PROMPT_RULES,
});

const localizeSyspromptDefaults = preset => localizeOfficialPromptRecord(
    preset,
    getCanonicalBuiltinPromptDefaults(),
);

const canonicalizeSyspromptDefaults = preset => canonicalizeOfficialPromptRecord(
    preset,
    getCanonicalBuiltinPromptDefaults(),
);

const ensurePhoneFormatPromptFields = (preset, seed = DEFAULT_PHONE_FORMAT_PROMPTS) => {
    const p = (preset && typeof preset === 'object') ? preset : null;
    if (!p) return;
    BUILTIN_PHONE_FORMAT_CHAT_PROMPT_SPECS.forEach((spec) => {
        if (typeof p[spec.enabledKey] !== 'boolean') {
            p[spec.enabledKey] = seed[spec.enabledKey] !== false;
        }
        if (typeof p[spec.rulesKey] !== 'string' || !p[spec.rulesKey].trim()) {
            p[spec.rulesKey] = String(seed[spec.rulesKey] ?? '');
        }
        p[spec.positionKey] = normalizePhoneFormatPromptPosition(p[spec.positionKey]);
        p[spec.depthKey] = normalizePhoneFormatPromptDepth(p[spec.depthKey]);
        p[spec.rulesKey] = sanitizePhoneFormatPromptText(p[spec.rulesKey], spec);
        if(withoutPhonePromptTime(p[spec.rulesKey])===seed[spec.rulesKey])p[spec.rulesKey]=seed[spec.rulesKey];
    });
};

const stripPromptMigrationNotes = (value) => {
    const raw = String(value ?? '');
    if (!raw) return '';
    return raw
        .replace(/^[ \t]*\uFF08\u6CE8\uFF1A[^\uFF09]*\uFF09[ \t]*$/gm, '')
        .replace(/(?:\r?\n[ \t]*){3,}/g, '\n\n')
        .trim();
};

const sanitizeGroupRulesText = (value) => stripPromptMigrationNotes(value);

const sanitizeMomentRulesText = (value) => stripPromptMigrationNotes(value);

const sanitizeMomentCreateRulesText = (value) => {
    const raw = stripPromptMigrationNotes(value);
    if (!raw) return '';
    return raw
        .split(/\r?\n/)
        .map((line) => {
            const compact = String(line || '').replace(/\s+/g, '');
            if (
                compact.includes('如果决定发布动态') &&
                compact.includes('<content>') &&
                compact.includes('moment_start') &&
                compact.includes('moment_end')
            ) {
                return CURRENT_MOMENT_CREATE_CONTENT_LINE;
            }
            return line;
        })
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
};

const looksDefaultMomentCommentRulesForMigration = (value) => {
    const raw = String(value || '');
    return raw.includes('你正在处理 QQ空间「动态评论回复」任务。') &&
        raw.includes('【输出硬性要求】') &&
        raw.includes('moment_reply_start') &&
        (
            raw.includes('此处只保留评论回复规则') ||
            raw.includes('发布者必须回复用户评论') ||
            (raw.includes('【reply_to 规则（用于楼中楼）】') && !raw.includes('【评论回应原则】'))
        );
};

const sanitizeMomentCommentRulesText = (value) => {
    const trimmed = String(value || '').trim();
    if (
        trimmed === LEGACY_DEFAULT_MOMENT_COMMENT_RULES.trim() ||
        trimmed === COMBINED_DEFAULT_MOMENT_COMMENT_RULES.trim() ||
        (
            trimmed.includes('你正在处理 QQ空间「动态评论回复」任务。') &&
            trimmed.includes('moment_id::输入中提供的 moment_id 原值') &&
            trimmed.includes('【评论回应原则】')
        ) ||
        (
            trimmed.includes('你正在处理 QQ空间「动态评论回复」任务。') &&
            trimmed.includes('本场景不要输出私聊/群聊标签块（只输出评论回复）') &&
            trimmed.includes('【评论回应原则】')
        ) ||
        (
            trimmed.includes('你正在处理 QQ空间「动态评论回复」任务。') &&
            trimmed.includes('【输入中会提供】') &&
            trimmed.includes('不要把动态评论扩展成私聊/群聊剧情') &&
            trimmed.includes('只输出一个 <content>...</content> 区块') &&
            trimmed.includes('reply_to:: 的值必须来自输入里提供的 comment_id / user_comment_id')
        ) ||
        (
            trimmed.includes('你正在处理 QQ空间「动态评论回复」任务。') &&
            trimmed.includes('reply_to:: 填被回复的角色名') &&
            trimmed.includes('reply_to::被回复角色名')
        ) ||
        (
            trimmed.includes('你正在处理 QQ空间「动态评论 / 发布后评论」任务。') &&
            trimmed.includes('moment_id::输入中提供的 moment_id 原值')
        )
    ) {
        return DEFAULT_MOMENT_COMMENT_RULES;
    }
    if (looksDefaultMomentCommentRulesForMigration(value)) {
        return DEFAULT_MOMENT_COMMENT_RULES;
    }
    return stripPromptMigrationNotes(value);
};

const sanitizeMomentPublishCommentRulesText = (value) => {
    const trimmed = String(value || '').trim();
    if (
        trimmed === COMBINED_DEFAULT_MOMENT_COMMENT_RULES.trim() ||
        (
            trimmed.includes('你正在处理 QQ空间「用户发布动态后的评论」任务。') &&
            trimmed.includes('moment_id::输入中提供的 moment_id 原值')
        ) ||
        (
            trimmed.includes('你正在处理 QQ空间「用户发布动态后的评论」任务。') &&
            trimmed.includes('moment_id::动态ID（使用输入中提供的 moment_id）')
        ) ||
        (
            trimmed.includes('你正在处理 QQ空间「用户发布动态后的评论」任务。') &&
            trimmed.includes('【输入中会提供】') &&
            trimmed.includes('本轮没有回复对象，请让可用联系人对这条动态进行自然评论') &&
            trimmed.includes('只输出一个 <content>')
        ) ||
        (
            trimmed.includes('你正在处理「评论{{user}}发布的动态」任务。') &&
            trimmed.includes('评论区块里只写评论行，不写动态 ID')
        ) ||
        (
            trimmed.includes('你正在处理 QQ空间「用户发布动态后的评论」任务。') &&
            trimmed.includes('本场景不要输出私聊/群聊标签块（只输出评论回复）') &&
            trimmed.includes('【评论回应原则】')
        ) ||
        (
            trimmed.includes('你正在处理 QQ空间「动态评论 / 发布后评论」任务。') &&
            trimmed.includes('moment_id::输入中提供的 moment_id 原值')
        )
    ) {
        return DEFAULT_MOMENT_PUBLISH_COMMENT_RULES;
    }
    return stripPromptMigrationNotes(value);
};

const looksDefaultAutoImagePromptRulesForMigration = (value) => {
    const raw = String(value || '');
    if (!raw) return false;
    if (raw.includes('<auto_image_generation>')) return true;
    const compact = raw.replace(/\s+/g, '');
    if (raw.includes('默认不要输出图片标签') && raw.includes('<image_prompt>')) return true;
    if (raw.includes('输出一个生图提示词标签') && raw.includes('<image_prompt>')) return true;
    if (compact.includes('MiPhone_end') && compact.includes('<image_prompt>')) return true;
    if (compact.includes('<tableEdit>') && compact.includes('<image_prompt>')) return true;
    if (
        raw.includes('自动生图标签规则，用于生成{{image_prompt_surface}}') &&
        raw.includes('提示词风格：{{image_prompt_style}}') &&
        raw.includes('<image_prompt>这里写完整生图提示词</image_prompt>') &&
        (!raw.includes('<generate_img_rule>') ||
            !raw.includes('{{image_prompt_decision_mode}}') ||
            !raw.includes('【AI决策规则】') ||
            !raw.includes('[img-内容] 是一般图片格式，<image_prompt> 是文生图格式') ||
            raw.includes('[img-<image_prompt>'))
    ) {
        return true;
    }
    return raw.includes('{{image_prompt_position_rule}}') &&
        raw.includes('{{image_prompt_surface}}') &&
        raw.includes('{{image_prompt_model}}') &&
        raw.includes('<image_prompt>');
};

const sanitizeAutoImagePromptRulesText = (value) => {
    if (looksDefaultAutoImagePromptRulesForMigration(value)) {
        return DEFAULT_AUTO_IMAGE_PROMPT_RULES;
    }
    return String(value || '')
        .split(/\r?\n/)
        .filter((line) => {
            const text = String(line || '');
            const compact = text.replace(/\s+/g, '');
            if (text.includes('{{image_prompt_position_rule}}')) return false;
            if (compact.includes('MiPhone_end') && compact.includes('<image_prompt>')) return false;
            if (compact.includes('<tableEdit>') && compact.includes('<image_prompt>')) return false;
            return true;
        })
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
};

const ensureAutoImagePromptFields = (preset) => {
    const p = (preset && typeof preset === 'object') ? preset : null;
    if (!p) return;
    const hadPosition = typeof p.auto_image_prompt_position === 'number';
    const hadDepth = typeof p.auto_image_prompt_depth === 'number';
    const hadRole = typeof p.auto_image_prompt_role === 'number';
    if (typeof p.auto_image_prompt_enabled !== 'boolean') p.auto_image_prompt_enabled = true;
    if (!hadPosition) p.auto_image_prompt_position = 4;
    if (!hadDepth) p.auto_image_prompt_depth = 0;
    if (typeof p.auto_image_prompt_role !== 'number') p.auto_image_prompt_role = 0;
    const shouldMigrateLegacyDefaultPosition =
        hadPosition && hadDepth && p.auto_image_prompt_position === 0 && p.auto_image_prompt_depth === 1 && (!hadRole || p.auto_image_prompt_role === 0);
    if (typeof p.auto_image_prompt_rules !== 'string' || !p.auto_image_prompt_rules.trim()) {
        p.auto_image_prompt_rules = DEFAULT_AUTO_IMAGE_PROMPT_RULES;
    } else if (looksDefaultAutoImagePromptRulesForMigration(p.auto_image_prompt_rules)) {
        p.auto_image_prompt_rules = DEFAULT_AUTO_IMAGE_PROMPT_RULES;
    }
    p.auto_image_prompt_rules = sanitizeAutoImagePromptRulesText(p.auto_image_prompt_rules);
    if (shouldMigrateLegacyDefaultPosition && p.auto_image_prompt_rules === DEFAULT_AUTO_IMAGE_PROMPT_RULES) {
        p.auto_image_prompt_position = 4;
        p.auto_image_prompt_depth = 0;
        p.auto_image_prompt_role = 0;
    }
    if (
        p.auto_image_prompt_default_prefix_migrated !== true &&
        p.auto_image_prompt_rules === DEFAULT_AUTO_IMAGE_PROMPT_RULES &&
        p.auto_image_prompt_position === 1 &&
        p.auto_image_prompt_depth === 0 &&
        p.auto_image_prompt_role === 0
    ) {
        p.auto_image_prompt_position = 4;
    }
    p.auto_image_prompt_default_prefix_migrated = true;
    if (
        p.auto_image_prompt_default_latest_migrated !== true &&
        p.auto_image_prompt_rules === DEFAULT_AUTO_IMAGE_PROMPT_RULES &&
        p.auto_image_prompt_position === 0 &&
        p.auto_image_prompt_depth === 0 &&
        p.auto_image_prompt_role === 0
    ) {
        p.auto_image_prompt_position = 4;
    }
    p.auto_image_prompt_default_latest_migrated = true;
};

const sanitizePhoneFormatPromptText = (value, spec = {}) => {
    const raw = String(value ?? '');
    if (!raw) return '';
    const entryId = String(spec?.entryId || '');
    const rulesKey = String(spec?.rulesKey || '');
    let out = stripPromptMigrationNotes(raw);
    if (entryId === '手机-格式3-QQ空间' || rulesKey === 'phone_format_moment_rules') {
        out = out.replace(/\n+【[^】]*评论[^】]*系统[^】]*】[\s\S]*?(?=\n+QQ空间仅会有主要角色发布的动态)/g, '\n');
    }
    if (entryId === '手机-格式2-QQ聊天' || rulesKey === 'phone_format_chat_rules') {
        out = out.split(LEGACY_PHONE_IMAGE_MESSAGE_RULES).join(CURRENT_PHONE_IMAGE_MESSAGE_RULES);
    }
    if (entryId === '手机-格式999-格式结尾' || rulesKey === 'phone_format_footer_rules') {
        out = out
            .split(/\r?\n/)
            .map((line) => (/^4\.\s*\*\*.*MiPhone_end.*\*\*\s*$/.test(String(line || '')) ? CURRENT_PHONE_FORMAT_FOOTER_RULE : line))
            .join('\n');
        if (/\/\*[\s\S]*?\*\//.test(out)) {
            out = out.replace(/\[手机正确格式\][\s\S]*?MiPhone_end[\s\S]*?(?=\n<\/线上格式>)/, CURRENT_PHONE_FORMAT_SKELETON);
        }
    }
    return out.replace(/\n{3,}/g, '\n\n').trim();
};

const looksDefaultDialogueRulesText = (value) => {
    const raw = String(value || '');
    return raw.includes('# 行为风格与节奏指南') || raw.includes('聊天风格与节奏（核心格式规则）');
};

const looksDefaultGroupRulesText = (value) => {
    const raw = String(value || '');
    return raw.includes('【群聊场景提示词】') && raw.includes('{{members}}');
};

const clone = (v) => {
    try {
        return structuredClone(v);
    } catch {
        return JSON.parse(JSON.stringify(v));
    }
};

const PRESET_TYPES = ['sysprompt', 'context', 'instruct', 'openai', 'reasoning'];
const PRESET_BINDING_MODES = ['chat', 'rp', 'moments'];
export const PRESET_APP_SCOPES = Object.freeze({
    creative: 'creative',
    chat: 'chat',
    all: 'all',
});

export const normalizePresetAppScope = (value, fallback = PRESET_APP_SCOPES.creative) => {
    const scope = String(value || '').trim().toLowerCase();
    return Object.values(PRESET_APP_SCOPES).includes(scope) ? scope : fallback;
};

export const isPresetEligibleForMode = (preset = {}, mode = 'chat') => {
    const scope = normalizePresetAppScope(preset?.app_scope, PRESET_APP_SCOPES.creative);
    const normalizedMode = String(mode || '').trim().toLowerCase();
    return scope === PRESET_APP_SCOPES.all
        || (normalizedMode === 'rp' || normalizedMode === 'creative'
            ? scope === PRESET_APP_SCOPES.creative
            : scope === PRESET_APP_SCOPES.chat);
};

const normalizeType = (type) => {
    const t = String(type || '').toLowerCase();
    if (PRESET_TYPES.includes(t)) return t;
    throw new Error(`Unknown preset type: ${type}`);
};

const ensureObj = (v, fallback) => (v && typeof v === 'object') ? v : fallback;
const isNonEmptyObject = (value) => Boolean(value && typeof value === 'object' && Object.keys(value).length);
const isPresetStoreState = (value) => Boolean(value && typeof value === 'object' && value.presets && typeof value.presets === 'object');

const hashKey = (value) => {
    let h = 2166136261;
    const raw = String(value || '');
    for (let i = 0; i < raw.length; i++) {
        h ^= raw.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
};

const sanitizeKeySegment = (value, max = 40) => {
    const raw = String(value || '').trim();
    let out = '';
    for (const ch of raw) {
        if (/^[a-zA-Z0-9_-]$/.test(ch)) out += ch;
        else out += '_';
        if (out.length >= max) break;
    }
    const cleaned = out.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    return cleaned || 'item';
};

const makePresetItemKey = (type, id) => {
    const t = normalizeType(type);
    const presetId = String(id || '').trim();
    return `${SHARDED_STORE_ITEM_PREFIX}_${t}_${hashKey(`${t}:${presetId}`)}_${sanitizeKeySegment(presetId)}`;
};

const makeEmptyPresetBuckets = () => Object.fromEntries(PRESET_TYPES.map(type => [type, {}]));

const normalizePresetIndex = (raw) => {
    if (!raw || typeof raw !== 'object' || raw._tooLarge) return null;
    const source = raw.items && typeof raw.items === 'object' ? raw.items : raw.presets;
    if (!source || typeof source !== 'object') return null;
    const items = makeEmptyPresetBuckets();
    for (const type of PRESET_TYPES) {
        const bucket = source[type] && typeof source[type] === 'object' ? source[type] : {};
        for (const [id, meta] of Object.entries(bucket)) {
            const presetId = String(id || '').trim();
            if (!presetId) continue;
            const itemMeta = meta && typeof meta === 'object' ? meta : {};
            const key = String(itemMeta.key || '').trim() || makePresetItemKey(type, presetId);
            items[type][presetId] = {
                key,
                name: String(itemMeta.name || presetId),
                updatedAt: Number.isFinite(Number(itemMeta.updatedAt)) ? Number(itemMeta.updatedAt) : 0,
            };
        }
    }
    return {
        version: 2,
        presetScopeSchemaVersion: Number(raw.presetScopeSchemaVersion) === 1 ? 1 : 0,
        active: ensureObj(raw.active, {}),
        builtinActive: ensureObj(raw.builtinActive, {}),
        enabled: ensureObj(raw.enabled, {}),
        bindings: normalizeBindingsState(raw.bindings),
        items,
        savedAt: Number.isFinite(Number(raw.savedAt)) ? Number(raw.savedAt) : 0,
    };
};

const buildPresetIndex = (state) => {
    const index = {
        version: 2,
        presetScopeSchemaVersion: 1,
        active: clone(ensureObj(state?.active, {})),
        builtinActive: clone(ensureObj(state?.builtinActive, {})),
        enabled: clone(ensureObj(state?.enabled, {})),
        bindings: normalizeBindingsState(state?.bindings),
        items: makeEmptyPresetBuckets(),
        savedAt: Date.now(),
    };
    for (const type of PRESET_TYPES) {
        const presets = state?.presets?.[type] && typeof state.presets[type] === 'object' ? state.presets[type] : {};
        for (const [id, data] of Object.entries(presets)) {
            const presetId = String(id || '').trim();
            if (!presetId) continue;
            index.items[type][presetId] = {
                key: makePresetItemKey(type, presetId),
                name: String(data?.name || presetId),
                updatedAt: Number.isFinite(Number(data?.updatedAt)) ? Number(data.updatedAt) : Date.now(),
            };
        }
    }
    return index;
};

const collectPresetItemKeys = (index) => {
    const keys = new Set();
    const normalized = normalizePresetIndex(index);
    if (!normalized) return keys;
    for (const type of PRESET_TYPES) {
        for (const meta of Object.values(normalized.items[type] || {})) {
            const key = String(meta?.key || '').trim();
            if (key) keys.add(key);
        }
    }
    return keys;
};

const makePresetItemPayload = (type, id, data) => ({
    version: 2,
    type,
    id,
    data,
});

const makePresetItemSignature = (type, id, data) => JSON.stringify(makePresetItemPayload(type, id, data));

const readPresetItemPayload = (payload, type, id) => {
    if (!payload || typeof payload !== 'object' || payload._tooLarge) return null;
    const data = payload.data && typeof payload.data === 'object' ? payload.data : null;
    if (!data) return null;
    const payloadType = String(payload.type || type).trim();
    const payloadId = String(payload.id || id).trim();
    if (payloadType !== type || payloadId !== id) return null;
    return data;
};

const normalizeBindingMode = (mode, { sessionId = '' } = {}) => {
    const raw = String(mode || '').trim().toLowerCase();
    if (raw === 'rp' || raw === 'creative') return 'rp';
    if (raw === 'moments' || raw === 'moment' || raw === 'dynamic' || raw === 'space') return 'moments';
    if (raw === 'chat' || raw === 'social') return 'chat';
    const sid = String(sessionId || '').trim().toLowerCase();
    return sid.startsWith('rp:') ? 'rp' : 'chat';
};

const makeEmptyBindingBucket = () => ({
    modes: Object.fromEntries(PRESET_BINDING_MODES.map(mode => [mode, ''])),
    sessions: {},
    sessionProfiles: {},
    sessionReasoning: {},
    modeProfiles: Object.fromEntries(PRESET_BINDING_MODES.map(mode => [mode, ''])),
    modeReasoning: {},
    modeBindingOrigins: Object.fromEntries(PRESET_BINDING_MODES.map(mode => [mode, ''])),
});

const normalizeBindingBucket = (raw) => {
    const source = raw && typeof raw === 'object' ? raw : {};
    const next = makeEmptyBindingBucket();
    const modesRaw = source.modes && typeof source.modes === 'object' ? source.modes : {};
    const sessionsRaw = source.sessions && typeof source.sessions === 'object' ? source.sessions : {};

    for (const mode of PRESET_BINDING_MODES) {
        next.modes[mode] = String(modesRaw[mode] || '').trim();
    }
    for (const [sid, presetId] of Object.entries(sessionsRaw)) {
        const sessionId = String(sid || '').trim();
        const boundId = String(presetId || '').trim();
        if (!sessionId || !boundId) continue;
        next.sessions[sessionId] = boundId;
    }

    const profilesRaw = source.sessionProfiles && typeof source.sessionProfiles === 'object' ? source.sessionProfiles : {};
    for (const [sid, pid] of Object.entries(profilesRaw)) {
        const sessionId = String(sid || '').trim();
        const profileId = String(pid || '').trim();
        if (sessionId && profileId) next.sessionProfiles[sessionId] = profileId;
    }

    const reasoningRaw = source.sessionReasoning && typeof source.sessionReasoning === 'object' ? source.sessionReasoning : {};
    for (const [sid, val] of Object.entries(reasoningRaw)) {
        const sessionId = String(sid || '').trim();
        if (!sessionId || !val || typeof val !== 'object') continue;
        next.sessionReasoning[sessionId] = {
            request_reasoning: val.request_reasoning === true,
            reasoning_effort: normalizeReasoningEffort(val.reasoning_effort, 'high', { allowCustom: true }),
        };
    }

    const modeProfilesRaw = source.modeProfiles && typeof source.modeProfiles === 'object' ? source.modeProfiles : {};
    for (const mode of PRESET_BINDING_MODES) {
        next.modeProfiles[mode] = String(modeProfilesRaw[mode] || '').trim();
    }

    const modeReasoningRaw = source.modeReasoning && typeof source.modeReasoning === 'object' ? source.modeReasoning : {};
    for (const mode of PRESET_BINDING_MODES) {
        const val = modeReasoningRaw[mode];
        if (val && typeof val === 'object') {
            next.modeReasoning[mode] = {
                request_reasoning: val.request_reasoning === true,
                reasoning_effort: normalizeReasoningEffort(val.reasoning_effort, 'high', { allowCustom: true }),
            };
        }
    }

    const modeBindingOriginsRaw = source.modeBindingOrigins && typeof source.modeBindingOrigins === 'object'
        ? source.modeBindingOrigins
        : {};
    for (const mode of PRESET_BINDING_MODES) {
        const origin = String(modeBindingOriginsRaw[mode] || '').trim().toLowerCase();
        next.modeBindingOrigins[mode] = ['explicit', 'legacy_migrated_mode_binding', 'cleared']
            .includes(origin)
            ? origin
            : '';
    }

    return next;
};

const normalizeBindingsState = (raw) => {
    const source = raw && typeof raw === 'object' ? raw : {};
    const byTypeSource = source.byType && typeof source.byType === 'object' ? source.byType : source;
    const byType = {};
    for (const type of PRESET_TYPES) {
        byType[type] = normalizeBindingBucket(byTypeSource[type]);
    }
    const migrationsRaw = source.migrations && typeof source.migrations === 'object' ? source.migrations : {};
    return {
        byType,
        migrations: {
            presetScopeV1: migrationsRaw.presetScopeV1?.completed === true
                ? {
                    completed: true,
                    migratedAt: Number.isFinite(Number(migrationsRaw.presetScopeV1.migratedAt))
                        ? Math.max(0, Math.trunc(Number(migrationsRaw.presetScopeV1.migratedAt)))
                        : 0,
                }
                : { completed: false, migratedAt: 0 },
        },
    };
};

const DEFAULT_OPENAI_IMPERSONATION_PROMPT = '[Write your next reply from the point of view of {{user}}, using the chat history so far as a guideline for the writing style of {{user}}. Don\'t write as {{char}} or system. Don\'t describe actions of {{char}}.]';

const normalizeResponseTarget = (value, fallback = 'character') => {
    const token = String(value || '').trim().toLowerCase();
    if (token === 'user') return 'user';
    if (token === 'character' || token === 'char' || token === 'assistant') return 'character';
    return String(fallback || '').trim().toLowerCase() === 'user' ? 'user' : 'character';
};

const MEMORY_DATA_POSITIONS = new Set([
    'after_persona',
    'system_end',
    'before_chat',
    'history_before',
    'history_after',
    'history_depth',
    'before_latest_user',
    'after_latest_user',
]);

const normalizeMemoryDataPosition = (value) => {
    const token = String(value || '').trim().toLowerCase();
    if (!token || token === 'follow_global' || token === 'inherit') return '';
    const parts = token.split(/[+,]/).map((part) => part.trim()).filter(Boolean);
    if (!parts.length) return '';
    const out = [];
    for (const part of parts) {
        if (!MEMORY_DATA_POSITIONS.has(part)) return '';
        if (!out.includes(part)) out.push(part);
    }
    return out.join('+');
};

const normalizeNonNegativeInt = (value, fallback = 0) => {
    const raw = Math.trunc(Number(value));
    return Number.isFinite(raw) ? Math.max(0, raw) : Math.max(0, Math.trunc(Number(fallback) || 0));
};

const normalizeOpenAIPreset = (preset) => {
    if (!preset || typeof preset !== 'object') return;

    preset.request_reasoning = normalizeBoolean(preset.request_reasoning, true);
    preset.reasoning_effort = normalizeReasoningEffort(preset.reasoning_effort, 'high', { allowCustom: true });
    preset.response_target_chat = normalizeResponseTarget(preset.response_target_chat, 'character');
    preset.response_target_rp = normalizeResponseTarget(preset.response_target_rp, 'user');
    preset.memory_data_position = normalizeMemoryDataPosition(preset.memory_data_position);
    preset.memory_data_depth = normalizeNonNegativeInt(preset.memory_data_depth, 0);
    preset.memory_guide_position = normalizeMemoryDataPosition(preset.memory_guide_position);
    preset.memory_guide_depth = normalizeNonNegativeInt(preset.memory_guide_depth, 0);
    // 旧版曾把生成参数预设自动绑定到当时的连线设置档，会导致切换文本模型后
    // 推理请求仍读取旧模型。连线绑定已迁移到会话配置管理，预设本体不再保存此字段。
    delete preset.boundProfileId;
    if (typeof preset.impersonation_prompt !== 'string' || !preset.impersonation_prompt.trim()) {
        preset.impersonation_prompt = DEFAULT_OPENAI_IMPERSONATION_PROMPT;
    }
    if (typeof preset.assistant_impersonation !== 'string') {
        preset.assistant_impersonation = '';
    }

    // SillyTavern PromptManager global dummy character id
    const ST_PROMPT_ORDER_DUMMY_ID = 100001;
    const ST_PROMPT_ORDER_FALLBACK_ID = 100000;

    const coerceRole = (role) => {
        if (role === 0) return 'system';
        if (role === 1) return 'user';
        if (role === 2) return 'assistant';
        const r = String(role || '').toLowerCase().trim();
        if (r === 'system' || r === 'user' || r === 'assistant') return r;
        return 'system';
    };

    const coerceIdentifier = (p, fallback) => {
        const cand = [
            p?.identifier,
            p?.id,
            p?.prompt_id,
            p?.promptId,
            p?.name,
            p?.title,
        ];
        for (const c of cand) {
            const s = String(c || '').trim();
            if (s) return s;
        }
        return fallback;
    };

    const coerceContent = (p) => {
        const cand = [
            p?.content,
            p?.prompt,
            p?.text,
            p?.value,
            p?.message,
        ];
        for (const c of cand) {
            const s = String(c ?? '');
            if (s.trim()) return s;
        }
        return String(p?.content ?? '');
    };

    // 1) Normalize prompts: ST exports are usually an array, but some forks use object maps or "prompt" instead of "content".
    let promptsRaw = preset.prompts;
    if (!Array.isArray(promptsRaw) && promptsRaw && typeof promptsRaw === 'object') {
        // Some exports are keyed by identifier: { main: {...}, nsfw: {...} }
        promptsRaw = Object.entries(promptsRaw).map(([key, value]) => {
            if (value && typeof value === 'object') {
                // Preserve the map key as identifier when missing.
                if (!('identifier' in value) || !String(value.identifier || '').trim()) {
                    return { ...value, identifier: String(key || '').trim() || value.identifier };
                }
                return value;
            }
            // Extremely defensive: allow string values.
            return { identifier: String(key || '').trim(), content: String(value ?? '') };
        });
    }
    const promptsIn = Array.isArray(promptsRaw) ? promptsRaw : [];

    const normalizedPrompts = [];
    const keyToIdentifier = new Map();
    for (let i = 0; i < promptsIn.length; i++) {
        const p = promptsIn[i];
        if (!p || typeof p !== 'object') continue;
        const identifier = coerceIdentifier(p, `custom_${i}`);
        const name = String(p?.name || p?.title || identifier).trim() || identifier;
        const role = coerceRole(p?.role);
        const system_prompt = (typeof p?.system_prompt === 'boolean') ? p.system_prompt : true;
        const marker = Boolean(p?.marker);
        const content = coerceContent(p);
        const out = { ...p, identifier, name, role, system_prompt, marker, content };
        normalizedPrompts.push(out);

        // Build a mapping so prompt_order entries that refer to "id"/"name" can be resolved.
        const keys = [
            identifier,
            String(p?.id || '').trim(),
            String(p?.prompt_id || '').trim(),
            String(p?.name || '').trim(),
            String(p?.title || '').trim(),
        ].filter(Boolean);
        for (const k of keys) {
            if (!keyToIdentifier.has(k)) keyToIdentifier.set(k, identifier);
        }
    }
    preset.prompts = normalizedPrompts;

    // 2) Normalize prompt_order blocks and merge identifiers so our UI/builder won't drop blocks.
    let blocks = preset.prompt_order;
    if (!Array.isArray(blocks) && blocks && typeof blocks === 'object') {
        // Some exports store as {character_id:..., order:[...]} directly.
        // Others store as a map: { "100001": {character_id:..., order:[...]} }
        if ('order' in blocks || 'character_id' in blocks) {
            blocks = [blocks];
        } else {
            blocks = Object.values(blocks);
        }
    }
    blocks = Array.isArray(blocks) ? blocks : [];

    // NOTE: Per product requirement, ONLY import/use the ST global dummyId (100001) block.
    // Do NOT merge other character_id blocks; do NOT auto-append missing prompts to order.
    const importBlock =
        blocks.find(b => b && typeof b === 'object' && String(b.character_id) === String(ST_PROMPT_ORDER_DUMMY_ID)) ||
        null;
    if (!importBlock) return;

    const ingestOrder = (orderArr) => {
        const out = [];
        const seen = new Set();
        const arr = Array.isArray(orderArr) ? orderArr : [];
        for (const it of arr) {
            // ST order items are usually {identifier, enabled}, but may use id/name or even be a string.
            const rawKey = (() => {
                if (typeof it === 'string') return it;
                if (typeof it === 'number' && Number.isFinite(it)) {
                    // Some forks store numeric indices instead of identifiers.
                    const idx = Math.trunc(it);
                    const fromPrompt = promptsIn[idx];
                    return fromPrompt && typeof fromPrompt === 'object' ? (fromPrompt.identifier ?? fromPrompt.id ?? fromPrompt.name) : '';
                }
                if (it && typeof it === 'object') return (it.identifier ?? it.id ?? it.prompt_id ?? it.promptId ?? it.name ?? it.title);
                return '';
            })();
            const key = String(rawKey || '').trim();
            if (!key) continue;
            const identifier = keyToIdentifier.get(key) || key;
            if (seen.has(identifier)) continue;
            seen.add(identifier);
            const enabled = (it && typeof it === 'object' && 'enabled' in it) ? (it.enabled !== false) : true;
            out.push({ identifier, enabled });
        }
        return out;
    };

    const order = ingestOrder(importBlock.order);
    if (!order.length) return;

    // Keep ONLY dummyId=100001 order block (align ST PromptManager global strategy).
    preset.prompt_order = [{ character_id: ST_PROMPT_ORDER_DUMMY_ID, order }];
};

const makeDefaultState = (defaultsByType) => {
    const findIdByName = (type, name) => {
        const entries = Object.entries(defaultsByType?.[type] || {});
        const hit = entries.find(([_, p]) => (p?.name || '') === name) || entries[0];
        return hit ? hit[0] : null;
    };

    const ctxId = findIdByName('context', 'Default') || findIdByName('context', 'ChatML');
    const sysId = findIdByName('sysprompt', 'Neutral - Chat') || findIdByName('sysprompt', 'Roleplay - Immersive');
    const insId = findIdByName('instruct', 'ChatML') || findIdByName('instruct', 'Llama 3 Instruct');
    const openaiId = findIdByName('openai', 'Default');
    const reasoningId = findIdByName('reasoning', 'DeepSeek') || findIdByName('reasoning', 'Blank');

    const presets = Object.fromEntries(PRESET_TYPES.map((type) => [
        type,
        Object.fromEntries(Object.entries(defaultsByType?.[type] || {}).map(([id, preset]) => [
            id,
            { ...(preset || {}), app_scope: PRESET_APP_SCOPES.creative },
        ])),
    ]));
    const active = {
        sysprompt: sysId,
        context: ctxId,
        instruct: insId,
        openai: openaiId,
        reasoning: reasoningId,
    };
    return {
        version: 1,
        presetScopeSchemaVersion: 1,
        presets,
        active,
        builtinActive: { ...active },
        enabled: {
            sysprompt: true,
            context: true,
            instruct: false,
            openai: true,
            reasoning: true,
        },
        bindings: {
            ...normalizeBindingsState(),
            migrations: {
                presetScopeV1: { completed: true, migratedAt: Date.now() },
            },
        },
    };
};

export const migratePresetScopeState = (input = {}, {
    builtinActive = {},
    existingInstall = true,
    now = Date.now,
} = {}) => {
    const state = input && typeof input === 'object' ? input : {};
    state.presets = ensureObj(state.presets, {});
    state.active = ensureObj(state.active, {});
    state.builtinActive = ensureObj(state.builtinActive, {});
    state.bindings = normalizeBindingsState(state.bindings);
    for (const type of PRESET_TYPES) {
        state.presets[type] = ensureObj(state.presets[type], {});
        for (const preset of Object.values(state.presets[type])) {
            if (!preset || typeof preset !== 'object') continue;
            preset.app_scope = normalizePresetAppScope(preset.app_scope, PRESET_APP_SCOPES.all);
        }
        const fallbackId = String(builtinActive?.[type] || '').trim();
        const currentBuiltinId = String(state.builtinActive[type] || '').trim();
        state.builtinActive[type] = state.presets[type][currentBuiltinId]
            ? currentBuiltinId
            : (state.presets[type][fallbackId] ? fallbackId : (Object.keys(state.presets[type])[0] || null));
    }
    state.presetScopeSchemaVersion = 1;
    if (state.bindings.migrations.presetScopeV1.completed === true) return state;
    if (existingInstall) {
        for (const type of PRESET_TYPES) {
            const bucket = state.bindings.byType[type];
            const globalId = String(state.active[type] || '').trim();
            if (!globalId || !state.presets[type][globalId]) continue;
            for (const mode of ['chat', 'moments']) {
                const existingId = String(bucket.modes[mode] || '').trim();
                if (existingId && state.presets[type][existingId]) continue;
                bucket.modes[mode] = globalId;
                bucket.modeBindingOrigins[mode] = 'legacy_migrated_mode_binding';
            }
        }
    }
    state.bindings.migrations.presetScopeV1 = {
        completed: true,
        migratedAt: Math.max(1, Math.trunc(Number(now?.() || Date.now()) || Date.now())),
    };
    return state;
};

export const hasLegacyMigratedPresetBindings = (input = {}) => {
    const bindings = normalizeBindingsState(input?.bindings);
    return PRESET_TYPES.some(type => PRESET_BINDING_MODES.some(mode => (
        String(bindings.byType[type]?.modes?.[mode] || '').trim()
        && bindings.byType[type]?.modeBindingOrigins?.[mode] === 'legacy_migrated_mode_binding'
    )));
};

export class PresetStore {
    constructor() {
        this.state = null;
        this.isLoaded = false;
        this.persistedItemSignatures = new Map();
        // TavernHelper's in_use edits are session-local working data. They are
        // deliberately outside state, so export/persist cannot save them.
        this.inUsePresets = new Map();
        this.ready = this.load();
    }

    async loadShardedState() {
        let indexRaw = null;
        try {
            indexRaw = await safeInvoke('load_kv', { name: SHARDED_STORE_INDEX_KEY });
        } catch (err) {
            logger.debug('load_kv sharded preset index failed (可能非 Tauri)', err);
            return { state: null, skipPersistOnLoad: false };
        }

        const index = normalizePresetIndex(indexRaw);
        if (!index) {
            if (isNonEmptyObject(indexRaw)) {
                if (indexRaw._tooLarge) {
                    logger.warn('preset sharded index too large; fallback to legacy store', indexRaw);
                } else {
                    logger.warn('preset sharded index invalid; fallback to legacy store', indexRaw);
                }
            }
            return { state: null, skipPersistOnLoad: false };
        }

        const state = {
            version: 1,
            presetScopeSchemaVersion: index.presetScopeSchemaVersion,
            presets: makeEmptyPresetBuckets(),
            active: index.active,
            builtinActive: index.builtinActive,
            enabled: index.enabled,
            bindings: index.bindings,
        };
        let skipPersistOnLoad = false;
        for (const type of PRESET_TYPES) {
            const bucket = index.items[type] || {};
            for (const [id, meta] of Object.entries(bucket)) {
                const presetId = String(id || '').trim();
                const key = String(meta?.key || '').trim();
                if (!presetId || !key) continue;
                try {
                    const payload = await safeInvoke('load_kv', { name: key });
                    if (payload && typeof payload === 'object' && payload._tooLarge) {
                        skipPersistOnLoad = true;
                        logger.warn('preset item payload too large; skip startup prune', { type, id: presetId, key, size: payload.size });
                        continue;
                    }
                    const data = readPresetItemPayload(payload, type, presetId);
                    if (data) {
                        state.presets[type][presetId] = data;
                        this.persistedItemSignatures.set(key, makePresetItemSignature(type, presetId, data));
                    }
                    else {
                        skipPersistOnLoad = true;
                        if (isNonEmptyObject(payload)) {
                            logger.warn('preset item payload invalid; skipped without startup prune', { type, id: presetId, key });
                        } else {
                            logger.warn('preset item payload missing; skipped without startup prune', { type, id: presetId, key });
                        }
                    }
                } catch (err) {
                    skipPersistOnLoad = true;
                    logger.warn('preset item load failed; skipped without startup prune', { type, id: presetId, key, err });
                }
            }
        }

        return { state, skipPersistOnLoad };
    }

    async persistShardedState(state) {
        const index = buildPresetIndex(state);
        let previousIndex = null;
        try {
            previousIndex = await safeInvoke('load_kv', { name: SHARDED_STORE_INDEX_KEY });
        } catch {}
        const previousKeys = collectPresetItemKeys(previousIndex);
        const nextKeys = collectPresetItemKeys(index);

        for (const type of PRESET_TYPES) {
            const presets = state?.presets?.[type] && typeof state.presets[type] === 'object' ? state.presets[type] : {};
            for (const [id, data] of Object.entries(presets)) {
                const presetId = String(id || '').trim();
                if (!presetId) continue;
                const key = index.items[type]?.[presetId]?.key || makePresetItemKey(type, presetId);
                const payload = makePresetItemPayload(type, presetId, data);
                const signature = JSON.stringify(payload);
                if (this.persistedItemSignatures.get(key) === signature) continue;
                await safeInvoke('save_kv', { name: key, data: payload });
                this.persistedItemSignatures.set(key, signature);
            }
        }

        await safeInvoke('save_kv', { name: SHARDED_STORE_INDEX_KEY, data: index });

        for (const key of previousKeys) {
            if (nextKeys.has(key)) continue;
            try {
                await safeInvoke('save_kv', { name: key, data: null });
                this.persistedItemSignatures.delete(key);
            } catch (err) {
                logger.debug('preset stale item cleanup failed', { key, err });
            }
        }
    }

    async loadBundledDefaults() {
        try {
            const resp = await fetch('./assets/presets/st-defaults.json', { cache: 'no-cache' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const json = await resp.json();
            const types = ensureObj(json?.types, {});
            const byType = {
                sysprompt: ensureObj(types.sysprompt, {}),
                context: ensureObj(types.context, {}),
                instruct: ensureObj(types.instruct, {}),
                openai: ensureObj(types.openai, {}),
                reasoning: ensureObj(types.reasoning, {}),
            };

            // Convert {name -> presetData} to {id -> presetDataWithName} (stable id = name)
            const out = {};
            for (const type of Object.keys(byType)) {
                out[type] = {};
                for (const [name, data] of Object.entries(byType[type])) {
                    out[type][name] = { ...data, name: data?.name || name };
                }
            }
            return out;
        } catch (err) {
            logger.warn('加载内置 ST 预设失败', err);
            return { sysprompt: {}, context: {}, instruct: {}, openai: {}, reasoning: {} };
        }
    }

    async load() {
        if (this.isLoaded && this.state) return this.state;

        this.persistedItemSignatures.clear();

        let state = null;
        let skipPersistOnLoad = false;

        const sharded = await this.loadShardedState();
        if (isPresetStoreState(sharded.state)) {
            state = sharded.state;
            skipPersistOnLoad = sharded.skipPersistOnLoad === true;
        }

        if (!state) {
            try {
                const kv = await safeInvoke('load_kv', { name: STORE_KEY });
                if (isPresetStoreState(kv)) {
                    state = kv;
                } else if (isNonEmptyObject(kv)) {
                    skipPersistOnLoad = true;
                    if (kv._tooLarge) {
                        logger.warn('preset store load_kv payload too large; skip startup overwrite', kv);
                    } else {
                        logger.warn('preset store load_kv payload invalid; skip startup overwrite', kv);
                    }
                }
            } catch (err) {
                logger.debug('load_kv preset store failed (可能非 Tauri)', err);
            }
        }

        if (!state) {
            try {
                const raw = localStorage.getItem(STORE_KEY);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (isPresetStoreState(parsed)) state = parsed;
                }
            } catch {}
        }

        const defaults = await this.loadBundledDefaults();
        const existingInstall = Boolean(state && typeof state === 'object' && state.presets);
        const bundledActive = makeDefaultState(defaults).active;
        const persistLoadedState = async (next) => {
            if (skipPersistOnLoad) {
                this.state = next;
                return;
            }
            await this.persist(next);
        };
        if (!state || typeof state !== 'object' || !state.presets) {
            state = makeDefaultState(defaults);
            // 对话模式默认值（保存于 sysprompt 预设）
            for (const p of Object.values(state.presets.sysprompt || {})) {
                if (!p || typeof p !== 'object') continue;
                ensurePhoneFormatPromptFields(p);
                if (typeof p.dialogue_enabled !== 'boolean') p.dialogue_enabled = true;
                // 聊天提示词：默认放在 prompt 前段，避免出现在最新用户消息之后。
                if (typeof p.dialogue_position !== 'number') p.dialogue_position = 0;
                if (typeof p.dialogue_depth !== 'number') p.dialogue_depth = 1;
                if (typeof p.dialogue_role !== 'number') p.dialogue_role = 0;
                if (typeof p.dialogue_rules !== 'string' || !p.dialogue_rules.trim()) {
                    p.dialogue_rules = DEFAULT_DIALOGUE_RULES_PRIVATE_CHAT;
                }
                if (p.dialogue_position === 3 && looksDefaultDialogueRulesText(p.dialogue_rules)) {
                    p.dialogue_position = 0;
                }
                if (typeof p.moment_enabled !== 'boolean') p.moment_enabled = false;
                if (typeof p.moment_position !== 'number') p.moment_position = 0;
                if (typeof p.moment_depth !== 'number') p.moment_depth = 0;
                if (typeof p.moment_role !== 'number') p.moment_role = 0;
                if (typeof p.moment_rules !== 'string' || !p.moment_rules.trim()) {
                    p.moment_rules = DEFAULT_MOMENT_RULES;
                }
                p.moment_rules = sanitizeMomentRulesText(p.moment_rules);

                // 分场景：动态发布决策 / 动态评论回复
                if (typeof p.moment_create_enabled !== 'boolean') p.moment_create_enabled = false;
                if (typeof p.moment_create_position !== 'number') p.moment_create_position = 0;
                if (typeof p.moment_create_depth !== 'number') p.moment_create_depth = 1;
                if (typeof p.moment_create_role !== 'number') p.moment_create_role = 0;
                if (typeof p.moment_create_rules !== 'string' || !p.moment_create_rules.trim()) {
                    p.moment_create_rules = DEFAULT_MOMENT_CREATION_RULES;
                }
                p.moment_create_rules = sanitizeMomentCreateRulesText(p.moment_create_rules);

                if (typeof p.moment_comment_enabled !== 'boolean') p.moment_comment_enabled = true;
                if (typeof p.moment_comment_position !== 'number') p.moment_comment_position = 0;
                if (typeof p.moment_comment_depth !== 'number') p.moment_comment_depth = 0;
                if (typeof p.moment_comment_role !== 'number') p.moment_comment_role = 0;
                if (typeof p.moment_comment_rules !== 'string' || !p.moment_comment_rules.trim()) {
                    p.moment_comment_rules = DEFAULT_MOMENT_COMMENT_RULES;
                }
                // Migration: 旧默认值「发布者必须回复用户评论」更新为更贴近社交应用的“高概率回复 + 可自行决策”
                try {
                    const cur = String(p.moment_comment_rules || '').trim();
                    if (cur && cur === LEGACY_DEFAULT_MOMENT_COMMENT_RULES.trim()) {
                        p.moment_comment_rules = DEFAULT_MOMENT_COMMENT_RULES;
                    }
                } catch {}
                p.moment_comment_rules = sanitizeMomentCommentRulesText(p.moment_comment_rules);

                if (typeof p.moment_publish_comment_enabled !== 'boolean') p.moment_publish_comment_enabled = true;
                if (typeof p.moment_publish_comment_position !== 'number') p.moment_publish_comment_position = 0;
                if (typeof p.moment_publish_comment_depth !== 'number') p.moment_publish_comment_depth = 0;
                if (typeof p.moment_publish_comment_role !== 'number') p.moment_publish_comment_role = 0;
                if (typeof p.moment_publish_comment_rules !== 'string' || !p.moment_publish_comment_rules.trim()) {
                    p.moment_publish_comment_rules = DEFAULT_MOMENT_PUBLISH_COMMENT_RULES;
                }
                p.moment_publish_comment_rules = sanitizeMomentPublishCommentRulesText(p.moment_publish_comment_rules);

                if (typeof p.group_enabled !== 'boolean') p.group_enabled = true;
                // 群聊提示词：同上，默认放在 prompt 前段。
                if (typeof p.group_position !== 'number') p.group_position = 0;
                if (typeof p.group_depth !== 'number') p.group_depth = 1;
                if (typeof p.group_role !== 'number') p.group_role = 0;
                if (typeof p.group_rules !== 'string' || !p.group_rules.trim()) {
                    p.group_rules = DEFAULT_GROUP_RULES;
                }
                p.group_rules = sanitizeGroupRulesText(p.group_rules);
                if (p.group_position === 3 && looksDefaultGroupRulesText(p.group_rules)) {
                    p.group_position = 0;
                }

                if (typeof p.summary_enabled !== 'boolean') p.summary_enabled = true;
                if (typeof p.summary_position !== 'number') p.summary_position = 1;
                if (typeof p.summary_rules !== 'string' || !p.summary_rules.trim()) {
                    p.summary_rules = DEFAULT_SUMMARY_RULES;
                }

                ensureAutoImagePromptFields(p);

                if (typeof p.ds_format_enabled !== 'boolean') p.ds_format_enabled = true;
                p.ds_format_rules = '';
            }
            try {
                for (const p of Object.values(state.presets.openai || {})) normalizeOpenAIPreset(p);
            } catch {}
            state = migratePresetScopeState(state, {
                builtinActive: bundledActive,
                existingInstall: false,
            });
            await persistLoadedState(state);
        } else {
            // ensure structure and merge defaults (do not overwrite user edits)
            state.version = 1;
            state.enabled = ensureObj(state.enabled, {});
            state.active = ensureObj(state.active, {});
            state.presets = ensureObj(state.presets, {});
            state.bindings = normalizeBindingsState(state.bindings);

            for (const type of PRESET_TYPES) {
                state.presets[type] = ensureObj(state.presets[type], {});
                for (const [id, data] of Object.entries(defaults[type] || {})) {
                    if (!state.presets[type][id]) {
                        state.presets[type][id] = {
                            ...(data || {}),
                            app_scope: PRESET_APP_SCOPES.creative,
                        };
                    }
                }
                if (!state.active[type] || !state.presets[type][state.active[type]]) {
                    state.active[type] = Object.keys(state.presets[type])[0] || null;
                }
                if (typeof state.enabled[type] !== 'boolean') {
                    state.enabled[type] = (type === 'sysprompt' || type === 'context' || type === 'openai' || type === 'reasoning');
                }
            }

            // 对话模式默认值（保存于 sysprompt 预设，不覆盖用户已配置内容）
            for (const p of Object.values(state.presets.sysprompt || {})) {
                if (!p || typeof p !== 'object') continue;
                ensurePhoneFormatPromptFields(p);
                if (typeof p.dialogue_enabled !== 'boolean') p.dialogue_enabled = true;
                // 私聊提示词：默认使用 ST IN_PROMPT；用户可改为 IN_CHAT depth/role。
                if (typeof p.dialogue_position !== 'number') p.dialogue_position = 0;
                if (typeof p.dialogue_depth !== 'number') p.dialogue_depth = 1;
                if (typeof p.dialogue_role !== 'number') p.dialogue_role = 0; // SYSTEM
                const rules = (typeof p.dialogue_rules === 'string') ? p.dialogue_rules : '';
                const looksLegacy = rules.includes('msg_start') && rules.includes('QQ 私聊格式协议') && !rules.includes('<content>');
                // Migration: 旧默认值包含 <content> 约束与大量格式说明（与世界书手机-格式重复）
                const looksDupDialogueDefault =
                    rules.includes('对话模式输出协议') &&
                    rules.includes('输出硬性要求') &&
                    (rules.includes('程序只会解析') || rules.includes('<content>'));
                if (typeof p.dialogue_rules !== 'string' || !p.dialogue_rules.trim() || looksLegacy || looksDupDialogueDefault) {
                    p.dialogue_rules = DEFAULT_DIALOGUE_RULES_PRIVATE_CHAT;
                }
                if (p.dialogue_position === 3 && looksDefaultDialogueRulesText(p.dialogue_rules)) {
                    p.dialogue_position = 0;
                }

                if (typeof p.moment_enabled !== 'boolean') p.moment_enabled = false;
                if (typeof p.moment_position !== 'number') p.moment_position = 0; // IN_PROMPT
                if (typeof p.moment_depth !== 'number') p.moment_depth = 0; // 与原文件“深度=0”一致
                if (typeof p.moment_role !== 'number') p.moment_role = 0;
                if (typeof p.moment_rules !== 'string' || !p.moment_rules.trim()) {
                    p.moment_rules = DEFAULT_MOMENT_RULES;
                }
                const mr = (typeof p.moment_rules === 'string') ? p.moment_rules : '';
                const looksOldMoment = mr.includes('<QQ空间格式介绍>') && mr.includes('moment_start') && !mr.includes('任务：动态发布决策');
                const looksCommentDisabledDefault = mr.includes('评论部分暂时注释') || mr.includes('请不要输出任何评论行') || mr.includes('评论系统暂时注释');
                if (looksOldMoment || looksCommentDisabledDefault) {
                    p.moment_rules = DEFAULT_MOMENT_RULES;
                }
                p.moment_rules = sanitizeMomentRulesText(p.moment_rules);

                // Migration: 旧 moment_* 迁移到 moment_comment_*（避免把“发布决策”误当成评论规则）
                if (typeof p.moment_comment_enabled !== 'boolean') p.moment_comment_enabled = true;
                if (typeof p.moment_comment_position !== 'number') p.moment_comment_position = (typeof p.moment_position === 'number') ? p.moment_position : 0;
                if (typeof p.moment_comment_depth !== 'number') p.moment_comment_depth = (typeof p.moment_depth === 'number') ? p.moment_depth : 0;
                if (typeof p.moment_comment_role !== 'number') p.moment_comment_role = (typeof p.moment_role === 'number') ? p.moment_role : 0;
                if (typeof p.moment_comment_rules !== 'string' || !p.moment_comment_rules.trim()) {
                    p.moment_comment_rules = DEFAULT_MOMENT_COMMENT_RULES;
                }
                try {
                    const cur = String(p.moment_comment_rules || '').trim();
                    if (cur && cur === LEGACY_DEFAULT_MOMENT_COMMENT_RULES.trim()) {
                        p.moment_comment_rules = DEFAULT_MOMENT_COMMENT_RULES;
                    }
                } catch {}
                p.moment_comment_rules = sanitizeMomentCommentRulesText(p.moment_comment_rules);

                if (typeof p.moment_publish_comment_enabled !== 'boolean') p.moment_publish_comment_enabled = true;
                if (typeof p.moment_publish_comment_position !== 'number') p.moment_publish_comment_position = 0;
                if (typeof p.moment_publish_comment_depth !== 'number') p.moment_publish_comment_depth = 0;
                if (typeof p.moment_publish_comment_role !== 'number') p.moment_publish_comment_role = 0;
                if (typeof p.moment_publish_comment_rules !== 'string' || !p.moment_publish_comment_rules.trim()) {
                    p.moment_publish_comment_rules = DEFAULT_MOMENT_PUBLISH_COMMENT_RULES;
                }
                p.moment_publish_comment_rules = sanitizeMomentPublishCommentRulesText(p.moment_publish_comment_rules);

                if (typeof p.moment_create_enabled !== 'boolean') p.moment_create_enabled = false;
                if (typeof p.moment_create_position !== 'number') p.moment_create_position = 0;
                if (typeof p.moment_create_depth !== 'number') p.moment_create_depth = 1;
                if (typeof p.moment_create_role !== 'number') p.moment_create_role = 0;
                if (typeof p.moment_create_rules !== 'string' || !p.moment_create_rules.trim()) {
                    p.moment_create_rules = DEFAULT_MOMENT_CREATION_RULES;
                }
                p.moment_create_rules = sanitizeMomentCreateRulesText(p.moment_create_rules);

                if (typeof p.group_enabled !== 'boolean') p.group_enabled = true;
                // 群聊提示词：默认使用 ST IN_PROMPT；用户可改为 IN_CHAT depth/role。
                if (typeof p.group_position !== 'number') p.group_position = 0;
                if (typeof p.group_depth !== 'number') p.group_depth = 1;
                if (typeof p.group_role !== 'number') p.group_role = 0;
                const gr = (typeof p.group_rules === 'string') ? p.group_rules : '';
                const looksDupGroupDefault = gr.includes('<QQ聊天格式介绍>') || (gr.includes('格式示例如') && gr.includes('<群聊:'));
                if (typeof p.group_rules !== 'string' || !p.group_rules.trim() || looksDupGroupDefault) {
                    p.group_rules = DEFAULT_GROUP_RULES;
                }
                p.group_rules = sanitizeGroupRulesText(p.group_rules);
                if (p.group_position === 3 && looksDefaultGroupRulesText(p.group_rules)) {
                    p.group_position = 0;
                }

                if (typeof p.summary_enabled !== 'boolean') p.summary_enabled = true;
                if (typeof p.summary_position !== 'number') p.summary_position = 1;
                else if (p.summary_position === 3 && String(p.summary_rules || '').trim() === DEFAULT_SUMMARY_RULES) p.summary_position = 1;
                if (typeof p.summary_rules !== 'string' || !p.summary_rules.trim()) {
                    p.summary_rules = DEFAULT_SUMMARY_RULES;
                }

                ensureAutoImagePromptFields(p);

                if (typeof p.ds_format_enabled !== 'boolean') p.ds_format_enabled = true;
                p.ds_format_rules = '';
            }
            try {
                for (const p of Object.values(state.presets.openai || {})) normalizeOpenAIPreset(p);
            } catch {}
            state = migratePresetScopeState(state, {
                builtinActive: bundledActive,
                existingInstall,
            });
            await persistLoadedState(state);
        }

        this.state = state;
        this.isLoaded = true;
        return this.state;
    }

    async persist(next = this.state) {
        this.state = next;
        try {
            await this.persistShardedState(this.state);
        } catch (err) {
            logger.warn('save_kv sharded preset store failed (可能非 Tauri)，回退 localStorage', err);
            try {
                localStorage.setItem(STORE_KEY, JSON.stringify(this.state));
            } catch {}
        }
    }

    getState() {
        return this.state ? clone(this.state) : null;
    }

    async importState(imported, { mode = 'merge' } = {}) {
        await this.ready;
        if (!imported || typeof imported !== 'object') throw new Error('无效的预设设定档');
        if (!imported.presets || !imported.active || !imported.enabled) throw new Error('不是预设设定档格式');

        const scopedBackup = Number(imported.presetScopeSchemaVersion) === 1;
        const prepared = clone(imported);
        for (const t of PRESET_TYPES) {
            const bucket = prepared.presets?.[t];
            if (!bucket || typeof bucket !== 'object') continue;
            for (const preset of Object.values(bucket)) {
                if (!preset || typeof preset !== 'object') continue;
                preset.app_scope = scopedBackup
                    ? normalizePresetAppScope(preset.app_scope, PRESET_APP_SCOPES.creative)
                    : PRESET_APP_SCOPES.creative;
            }
        }
        prepared.presetScopeSchemaVersion = 1;
        if (!scopedBackup) {
            prepared.bindings = normalizeBindingsState();
            prepared.bindings.migrations.presetScopeV1 = {
                completed: true,
                migratedAt: Date.now(),
            };
        }

        const next = clone(this.state || {});
        if (mode === 'replace') {
            this.state = prepared;
            this.isLoaded = false;
            await this.persist(this.state);
            await this.load(); // normalize + merge defaults
            return this.getState();
        }

        // merge: overwrite by id, keep existing otherwise
        for (const t of PRESET_TYPES) {
            next.presets ||= {};
            next.presets[t] ||= {};
            const incoming = prepared.presets?.[t];
            if (incoming && typeof incoming === 'object') {
                for (const [id, data] of Object.entries(incoming)) {
                    next.presets[t][id] = data;
                }
            }
            if (prepared.active?.[t]) next.active ||= {};
            if (prepared.active?.[t]) next.active[t] = prepared.active[t];
            if (typeof prepared.enabled?.[t] === 'boolean') {
                next.enabled ||= {};
                next.enabled[t] = prepared.enabled[t];
            }
        }

        if (scopedBackup && prepared.bindings && typeof prepared.bindings === 'object') {
            const incomingBindings = normalizeBindingsState(prepared.bindings);
            next.bindings = normalizeBindingsState(next.bindings);
            for (const t of PRESET_TYPES) {
                next.bindings.byType[t] = incomingBindings.byType[t];
            }
        }

        next.presetScopeSchemaVersion = 1;

        this.state = next;
        this.isLoaded = false;
        await this.persist(this.state);
        await this.load();
        return this.getState();
    }

    getEnabled(type) {
        const t = normalizeType(type);
        return Boolean(this.state?.enabled?.[t]);
    }

    async setEnabled(type, enabled) {
        await this.ready;
        const t = normalizeType(type);
        this.state.enabled[t] = Boolean(enabled);
        await this.persist();
        return this.getState();
    }

    list(type) {
        const t = normalizeType(type);
        const entries = Object.entries(this.state?.presets?.[t] || {});
        entries.sort((a, b) => String(a[1]?.name || a[0]).localeCompare(String(b[1]?.name || b[0])));
        return entries.map(([id, data]) => {
            const preset = clone(data);
            return { id, ...(t === 'sysprompt' ? localizeSyspromptDefaults(preset) : preset) };
        });
    }

    getActiveId(type) {
        const t = normalizeType(type);
        return this.state?.active?.[t] || null;
    }

    getActive(type) {
        const t = normalizeType(type);
        const id = this.getActiveId(t);
        if (!id) return null;
        const preset = clone(this.state?.presets?.[t]?.[id] || null);
        return t === 'sysprompt' && preset ? localizeSyspromptDefaults(preset) : preset;
    }

    getBindings(type) {
        const t = normalizeType(type);
        return clone(normalizeBindingBucket(this.state?.bindings?.byType?.[t]));
    }

    getModeBindingId(type, mode) {
        const t = normalizeType(type);
        const m = normalizeBindingMode(mode);
        return String(this.state?.bindings?.byType?.[t]?.modes?.[m] || '').trim() || null;
    }

    getSessionBindingId(type, sessionId) {
        const t = normalizeType(type);
        const sid = String(sessionId || '').trim();
        if (!sid) return null;
        return String(this.state?.bindings?.byType?.[t]?.sessions?.[sid] || '').trim() || null;
    }

    getResolvedActiveId(type, context = {}) {
        const t = normalizeType(type);
        const presets = this.state?.presets?.[t] || {};
        const bucket = normalizeBindingBucket(this.state?.bindings?.byType?.[t]);
        const sessionId = String(context?.sessionId || '').trim();
        const mode = normalizeBindingMode(context?.uiMode, { sessionId });
        const hasPreset = (id) => Boolean(id && presets?.[id]);
        const hasEligiblePreset = (id) => hasPreset(id) && isPresetEligibleForMode(presets[id], mode);
        const builtinId = String(this.state?.builtinActive?.[t] || '').trim();
        const result = (presetId, source, bindingOrigin = '') => ({
            presetId: presetId || null,
            source,
            sessionId,
            mode,
            bindingOrigin,
            hasExplicitBinding: source === 'session' || source === 'mode',
            isBuiltinDefault: Boolean(presetId && presetId === builtinId),
            hasCustomBinding: Boolean(
                (source === 'session' || source === 'mode')
                && presetId
                && presetId !== builtinId
            ),
        });

        const sessionBoundId = sessionId ? String(bucket.sessions?.[sessionId] || '').trim() : '';
        if (sessionBoundId && hasEligiblePreset(sessionBoundId)) {
            return result(sessionBoundId, 'session', 'explicit');
        }

        const modeBoundId = String(bucket.modes?.[mode] || '').trim();
        if (modeBoundId && hasEligiblePreset(modeBoundId)) {
            return result(modeBoundId, 'mode', String(bucket.modeBindingOrigins?.[mode] || 'explicit'));
        }

        if (mode === 'rp') {
            const globalId = String(this.state?.active?.[t] || '').trim();
            if (globalId && hasEligiblePreset(globalId)) return result(globalId, 'global');
        }
        return result(hasEligiblePreset(builtinId) ? builtinId : null, 'builtin');
    }

    getResolvedActive(type, context = {}) {
        const t = normalizeType(type);
        const resolved = this.getResolvedActiveId(t, context);
        const presetId = String(resolved?.presetId || '').trim();
        const draft = this.resolveInUsePreset(t, context);
        const preset = presetId ? clone(draft?.preset || this.state?.presets?.[t]?.[presetId] || null) : null;
        return {
            ...resolved,
            preset: t === 'sysprompt' && preset ? localizeSyspromptDefaults(preset) : preset,
        };
    }

    resolveInUsePreset(type, context = {}) {
        const t = normalizeType(type);
        const key = JSON.stringify([t, String(context.sessionId || '')]);
        const draft = this.inUsePresets?.get(key);
        if (!draft) return null;
        const id = this.getResolvedActiveId(t, context)?.presetId;
        // Switching presets or explicitly saving through the normal editor
        // makes the saved preset authoritative again.
        if (draft.presetId !== id || draft.base !== this.state?.presets?.[t]?.[id]) {
            this.inUsePresets.delete(key);
            return null;
        }
        return draft;
    }

    setInUsePreset(type, context, presetId, preset, regexes = []) {
        const t = normalizeType(type);
        const sid = String(context?.sessionId || '');
        if (!sid || this.getResolvedActiveId(t, context)?.presetId !== presetId) {
            throw new Error('预设已切换，请重新应用设置');
        }
        this.inUsePresets ||= new Map();
        this.inUsePresets.set(JSON.stringify([t, sid]), {
            presetId, base: this.state.presets[t][presetId],
            preset: clone(preset), regexes: clone(regexes),
        });
    }

    getInUsePresetRegexOverrides(type, context = {}) {
        const draft = this.resolveInUsePreset(type, context);
        return draft ? clone(draft.regexes) : null;
    }

    clearInUsePreset(type, sessionId) {
        this.inUsePresets?.delete(JSON.stringify([normalizeType(type), String(sessionId || '')]));
    }

    async setActive(type, id) {
        await this.ready;
        const t = normalizeType(type);
        if (!id || !this.state?.presets?.[t]?.[id]) {
            // 不存在的 ID 必须显式失败：静默 no-op 会让程序化调用方（脚本/工具/导入链）
            // 误以为切换成功，后续脚本 sync 与 prompt 构建全部对着旧预设跑。
            logger.warn(`[preset-store] setActive ignored: ${t} 预设不存在 id=${String(id || '')}`);
            return null;
        }
        this.state.active[t] = id;
        await this.persist();
        return this.getState();
    }

    async setModeBinding(type, mode, presetId = '') {
        await this.ready;
        const t = normalizeType(type);
        const m = normalizeBindingMode(mode);
        const nextId = String(presetId || '').trim();
        if (nextId && (
            !this.state?.presets?.[t]?.[nextId]
            || !isPresetEligibleForMode(this.state.presets[t][nextId], m)
        )) return this.getBindings(t);
        this.state.bindings ||= normalizeBindingsState();
        this.state.bindings.byType ||= {};
        this.state.bindings.byType[t] = normalizeBindingBucket(this.state.bindings.byType[t]);
        this.state.bindings.byType[t].modes[m] = nextId;
        this.state.bindings.byType[t].modeBindingOrigins[m] = nextId ? 'explicit' : 'cleared';
        await this.persist();
        return this.getBindings(t);
    }

    async clearModeBinding(type, mode) {
        return this.setModeBinding(type, mode, '');
    }

    async setSessionBinding(type, sessionId, presetId = '') {
        await this.ready;
        const t = normalizeType(type);
        const sid = String(sessionId || '').trim();
        if (!sid) return this.getBindings(t);
        const nextId = String(presetId || '').trim();
        const sessionMode = normalizeBindingMode('', { sessionId: sid });
        if (nextId && (
            !this.state?.presets?.[t]?.[nextId]
            || !isPresetEligibleForMode(this.state.presets[t][nextId], sessionMode)
        )) return this.getBindings(t);
        this.state.bindings ||= normalizeBindingsState();
        this.state.bindings.byType ||= {};
        this.state.bindings.byType[t] = normalizeBindingBucket(this.state.bindings.byType[t]);
        if (nextId) this.state.bindings.byType[t].sessions[sid] = nextId;
        else delete this.state.bindings.byType[t].sessions[sid];
        await this.persist();
        return this.getBindings(t);
    }

    async clearSessionBinding(type, sessionId) {
        return this.setSessionBinding(type, sessionId, '');
    }

    getSessionProfileId(type, sessionId) {
        const t = normalizeType(type);
        const sid = String(sessionId || '').trim();
        if (!sid) return null;
        return String(this.state?.bindings?.byType?.[t]?.sessionProfiles?.[sid] || '').trim() || null;
    }

    async setSessionProfile(type, sessionId, profileId = '') {
        await this.ready;
        const t = normalizeType(type);
        const sid = String(sessionId || '').trim();
        if (!sid) return this.getBindings(t);
        const nextId = String(profileId || '').trim();
        this.state.bindings ||= normalizeBindingsState();
        this.state.bindings.byType ||= {};
        this.state.bindings.byType[t] = normalizeBindingBucket(this.state.bindings.byType[t]);
        if (nextId) this.state.bindings.byType[t].sessionProfiles[sid] = nextId;
        else {
            delete this.state.bindings.byType[t].sessionProfiles[sid];
            delete this.state.bindings.byType[t].sessionReasoning[sid];
        }
        await this.persist();
        return this.getBindings(t);
    }

    async clearSessionProfile(type, sessionId) {
        return this.setSessionProfile(type, sessionId, '');
    }

    getSessionReasoning(type, sessionId) {
        const t = normalizeType(type);
        const sid = String(sessionId || '').trim();
        if (!sid) return null;
        const val = this.state?.bindings?.byType?.[t]?.sessionReasoning?.[sid];
        if (!val || typeof val !== 'object') return null;
        return {
            request_reasoning: val.request_reasoning === true,
            reasoning_effort: normalizeReasoningEffort(val.reasoning_effort, 'high', { allowCustom: true }),
        };
    }

    async setSessionReasoning(type, sessionId, reasoning = {}) {
        await this.ready;
        const t = normalizeType(type);
        const sid = String(sessionId || '').trim();
        if (!sid) return this.getBindings(t);
        this.state.bindings ||= normalizeBindingsState();
        this.state.bindings.byType ||= {};
        this.state.bindings.byType[t] = normalizeBindingBucket(this.state.bindings.byType[t]);
        this.state.bindings.byType[t].sessionReasoning[sid] = {
            request_reasoning: reasoning?.request_reasoning === true,
            reasoning_effort: normalizeReasoningEffort(reasoning?.reasoning_effort, 'high', { allowCustom: true }),
        };
        await this.persist();
        return this.getBindings(t);
    }

    async clearSessionReasoning(type, sessionId) {
        await this.ready;
        const t = normalizeType(type);
        const sid = String(sessionId || '').trim();
        if (!sid) return this.getBindings(t);
        this.state.bindings ||= normalizeBindingsState();
        this.state.bindings.byType ||= {};
        this.state.bindings.byType[t] = normalizeBindingBucket(this.state.bindings.byType[t]);
        delete this.state.bindings.byType[t].sessionReasoning[sid];
        await this.persist();
        return this.getBindings(t);
    }

    getModeProfileId(type, mode) {
        const t = normalizeType(type);
        const m = normalizeBindingMode(mode);
        return String(this.state?.bindings?.byType?.[t]?.modeProfiles?.[m] || '').trim() || null;
    }

    async setModeProfile(type, mode, profileId = '') {
        await this.ready;
        const t = normalizeType(type);
        const m = normalizeBindingMode(mode);
        const nextId = String(profileId || '').trim();
        this.state.bindings ||= normalizeBindingsState();
        this.state.bindings.byType ||= {};
        this.state.bindings.byType[t] = normalizeBindingBucket(this.state.bindings.byType[t]);
        this.state.bindings.byType[t].modeProfiles[m] = nextId;
        if (!nextId) delete this.state.bindings.byType[t].modeReasoning[m];
        await this.persist();
        return this.getBindings(t);
    }

    async clearModeProfile(type, mode) {
        return this.setModeProfile(type, mode, '');
    }

    getModeReasoning(type, mode) {
        const t = normalizeType(type);
        const m = normalizeBindingMode(mode);
        const val = this.state?.bindings?.byType?.[t]?.modeReasoning?.[m];
        if (!val || typeof val !== 'object') return null;
        return {
            request_reasoning: val.request_reasoning === true,
            reasoning_effort: normalizeReasoningEffort(val.reasoning_effort, 'high', { allowCustom: true }),
        };
    }

    async setModeReasoning(type, mode, reasoning = {}) {
        await this.ready;
        const t = normalizeType(type);
        const m = normalizeBindingMode(mode);
        this.state.bindings ||= normalizeBindingsState();
        this.state.bindings.byType ||= {};
        this.state.bindings.byType[t] = normalizeBindingBucket(this.state.bindings.byType[t]);
        this.state.bindings.byType[t].modeReasoning[m] = {
            request_reasoning: reasoning?.request_reasoning === true,
            reasoning_effort: normalizeReasoningEffort(reasoning?.reasoning_effort, 'high', { allowCustom: true }),
        };
        await this.persist();
        return this.getBindings(t);
    }

    async clearModeReasoning(type, mode) {
        await this.ready;
        const t = normalizeType(type);
        const m = normalizeBindingMode(mode);
        this.state.bindings ||= normalizeBindingsState();
        this.state.bindings.byType ||= {};
        this.state.bindings.byType[t] = normalizeBindingBucket(this.state.bindings.byType[t]);
        delete this.state.bindings.byType[t].modeReasoning[m];
        await this.persist();
        return this.getBindings(t);
    }

    applyUpsert(type, { id, name, data, makeActive, appScope } = {}) {
        const t = normalizeType(type);
        const presetId = id || genId(`preset-${t}`);
        const existing = this.state?.presets?.[t]?.[presetId] || null;
        let next = {
            ...(data || {}),
            name: String(name || data?.name || presetId),
            app_scope: normalizePresetAppScope(
                appScope ?? data?.app_scope ?? existing?.app_scope,
                PRESET_APP_SCOPES.creative,
            ),
        };
        if (t === 'sysprompt') {
            next = canonicalizeSyspromptDefaults(next);
            ensurePhoneFormatPromptFields(next);
            ensureAutoImagePromptFields(next);
            if (typeof next.group_rules === 'string') {
                next.group_rules = sanitizeGroupRulesText(next.group_rules);
            }
        }
        if (t === 'openai') {
            try { normalizeOpenAIPreset(next); } catch {}
        }
        this.state.presets[t][presetId] = next;
        // IMPORTANT: do not implicitly switch the active preset when updating existing ones,
        // otherwise "Save" across multiple drafts will end up selecting the last-saved preset.
        const shouldActivate = (typeof makeActive === 'boolean')
            ? makeActive
            : !id; // default: only auto-activate on create/import
        if (shouldActivate) this.state.active[t] = presetId;
        return presetId;
    }

    async upsertMany(items = []) {
        await this.ready;
        const records = Array.isArray(items)
            ? items.map(item => ({
                ...item,
                type: normalizeType(item?.type || item?.storeType),
                id: item?.id || item?.presetId,
            }))
            : [];
        if (!records.length) return [];
        const ids = records.map(item => this.applyUpsert(item.type, item));
        await this.persist();
        return ids;
    }

    async upsert(type, options = {}) {
        await this.ready;
        const presetId = this.applyUpsert(type, options);
        await this.persist();
        return presetId;
    }

    async setPresetAppScope(type, id, scope = PRESET_APP_SCOPES.creative) {
        await this.ready;
        const t = normalizeType(type);
        const presetId = String(id || '').trim();
        if (!presetId || !this.state?.presets?.[t]?.[presetId]) return null;
        this.state.presets[t][presetId].app_scope = normalizePresetAppScope(scope, PRESET_APP_SCOPES.creative);
        await this.persist();
        return clone(this.state.presets[t][presetId]);
    }

    async remove(type, id) {
        await this.ready;
        const t = normalizeType(type);
        if (!id || !this.state?.presets?.[t]?.[id]) return;
        delete this.state.presets[t][id];
        this.state.bindings ||= normalizeBindingsState();
        this.state.bindings.byType ||= {};
        this.state.bindings.byType[t] = normalizeBindingBucket(this.state.bindings.byType[t]);
        for (const mode of PRESET_BINDING_MODES) {
            if (this.state.bindings.byType[t].modes[mode] === id) {
                this.state.bindings.byType[t].modes[mode] = '';
                this.state.bindings.byType[t].modeBindingOrigins[mode] = 'cleared';
            }
        }
        for (const [sid, presetId] of Object.entries(this.state.bindings.byType[t].sessions || {})) {
            if (presetId === id) delete this.state.bindings.byType[t].sessions[sid];
        }
        const ids = Object.keys(this.state.presets[t]);
        if (this.state.active[t] === id) {
            this.state.active[t] = ids[0] || null;
        }
        if (this.state.builtinActive?.[t] === id) {
            this.state.builtinActive[t] = ids[0] || null;
        }
        await this.persist();
    }
}
