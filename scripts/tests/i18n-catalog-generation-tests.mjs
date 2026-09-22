import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { AGENT_FEATURE_DEFINITIONS } from '../../src/scripts/agent/agent-feature-settings.js';
import { getAgentCardDefinitions } from '../../src/scripts/ui/agent-center-card-catalog.js';

const readJson = async path => JSON.parse(await fs.readFile(path, 'utf8'));
const sourceEntries = await readJson('scripts/i18n/ui-source-catalog.json');
const english = await readJson('src/scripts/i18n/locales/en.json');
const traditional = await readJson('src/scripts/i18n/locales/zh-TW.json');
const pseudo = await readJson('src/scripts/i18n/locales/pseudo.json');
const appSource = await fs.readFile('src/scripts/ui/app.js', 'utf8');
const chatUiSource = await fs.readFile('src/scripts/ui/chat/chat-ui.js', 'utf8');

const sources = new Set(sourceEntries.map(entry => entry.source));
assert.ok(sources.has('提示词 {count}'), 'manual dynamic UI source keys must be extracted');
// Validate current UI definitions and their extraction provenance instead of freezing obsolete copy.
const entriesBySource = new Map(sourceEntries.map(entry => [entry.source, entry]));
for (const [file, definitions] of [
  ['src/scripts/agent/agent-feature-settings.js', AGENT_FEATURE_DEFINITIONS],
  ['src/scripts/ui/agent-center-card-catalog.js', getAgentCardDefinitions()],
]) {
  assert.ok(definitions.length > 0, `Agent Center definitions must be available: ${file}`);
  for (const definition of definitions) {
    const texts = [definition.title, definition.summary, definition.detailTitle, ...definition.detail].filter(Boolean);
    for (const source of texts) {
      assert.ok(
        entriesBySource.get(source)?.references.includes(`${file}#ui-definition`),
        `Agent Center UI definition must be extracted from ${file} (${definition.id}): ${source}`,
      );
      for (const [locale, catalog] of Object.entries({ en: english, 'zh-TW': traditional, pseudo })) {
        assert.ok(Object.hasOwn(catalog, source), `${locale} must cover Agent Center UI (${definition.id}): ${source}`);
      }
    }
  }
}
for (const source of ['比例', '面部修复', '关闭安全检查', '噪声调度']) {
  assert.ok(sources.has(source), `positional UI builder labels must be extracted: ${source}`);
}
for (const source of [
  "sampler', '采样器",
  "memory.bridge.group_header', '【群聊：{name}】",
  "', defaultValue = '', confirmText = '确定",
]) {
  assert.equal(sources.has(source), false, `cross-quote extractor fragment must not enter the catalog: ${source}`);
}
const auditedSurfaceTranslations = {
  '私聊格式提示词': 'Private Chat Format Prompt',
  '该提示词按位置/深度锚定注入，不参与区块拖拽排序；与 Agent Center 内对应编辑器为同一份数据。': 'This prompt is anchored by position and depth. It is not reordered with prompt blocks and shares the same data with the corresponding Agent Center editor.',
  '配置 · 修改后即时生效': 'Settings · Changes take effect immediately',
  '完整请求预览': 'Full Request Preview',
  '模型覆盖': 'Model Override',
  '上下文血缘图谱': 'Context Lineage Graph',
  '点击任意节点，追踪它的': 'Select any node to trace its',
  '用逗号或换行分隔': 'Separate with commas or line breaks',
  '逗号分隔多个组': 'Separate multiple groups with commas',
  '当前分页设置': 'Current Page Settings',
  '条目级变量门控': 'Entry-level Variable Gate',
  '条件链': 'Condition Chain',
  '会话配置管理': 'Session Configuration',
  '为各会话设定预设、连线配置与推理覆盖': 'Set presets, connection profiles, and reasoning overrides for each session',
  '这个人还没有留下个性签名。': 'This contact has not added a bio yet.',
  '相识天数': 'Days Known',
  '累计对话': 'Conversations',
  '人格设定': 'Profile Details',
  '问女仆...': 'Ask the maid...',
  '例如：外表冷淡、说话简短，但会在关键时刻保护同伴。': 'For example: Aloof and terse, but protective when it matters.',
  '评论': 'Comment',
  '浏览{count}次': '{count} views',
  '评论{count}条': '{count} comments',
  '发布动态': 'Create Post',
  'AI 生成贴图': 'AI Sticker Generator',
  '动图模式': 'Sprite Mode',
  '粘贴完整提示词，或描述想生成的图片': 'Paste a complete prompt or describe the image you want',
  '相册': 'Gallery',
  '群聊格式提示词': 'Group Chat Format Prompt',
  '全局世界书（所有会话共享）': 'Global lorebooks (shared across all sessions)',
  '全局当前：{value}': 'Global Active: {value}',
  '条目门控': 'Entry Gate',
  '{count} 路输入': '{count} inputs',
  '当前值：{value}': 'Current value: {value}',
  '左侧变量未设置，当前按待完善处理。': 'The left-side variable is not set, so this condition is treated as incomplete.',
  '左侧：{status}': 'Left: {status}',
  '右侧：{status}': 'Right: {status}',
  '当前 {count} 条子条件都尚未产出可判断结果。': 'None of the {count} child conditions has produced an evaluable result yet.',
  'AND 需要全部命中，未命中输入：{ports}（另有 {count} 路待判断）。': 'AND requires every input to match. Unmatched inputs: {ports}; {count} more remain pending.',
  '待完善项（{count}）': 'Incomplete Items ({count})',
  '类型：{value}': 'Type: {value}',
  '变量 {name}': 'Variable {name}',
  '暂无本次注入审计记录': 'No injection audit is available for this request',
  '所有消息按实际发送顺序展开；行号仅用于浏览，不会进入请求。': 'Messages are shown in the order sent. Line numbers are for navigation only and are not included in the request.',
  '自动换行': 'Word Wrap',
  '本轮没有改变行为的结构化请求参数': 'No structured request parameters changed behavior for this request',
  '传输层 · 展开查看实际发送内容': 'Transport Layer · Expand to view the content actually sent',
  '暂无 Prompt 内容': 'No Prompt content',
  '群聊格式提示词已被停用，实际发送不会注入': 'The group-chat format prompt is disabled and will not be injected into the actual request',
  '当前没有匹配输入，因此按“有内容即参与”处理': 'No matching input is currently available, so this participates whenever it has content',
};
for (const [source, translated] of Object.entries(auditedSurfaceTranslations)) {
  assert.ok(sources.has(source), `audited UI source key must be extracted: ${source}`);
  assert.equal(english[source], translated, `English translation must cover audited UI source: ${source}`);
}

const appHighFrequencyTranslations = {
  '正在联网搜索…': 'Searching the web…',
  '正在以传统格式重试…': 'Retrying with the traditional format…',
  '当前模型的联网请求已安全跳过：{value}': 'Web search was safely skipped for the current model: {value}',
  '当前模型暂不支持这组联网工具。': 'The current model does not support these web search tools.',
  '联网未启用': 'Web Search Unavailable',
  '聊天预设已整理': 'Chat Preset Updated',
  '引用的设置档已更换服务商': 'The referenced profile now uses a different provider',
  '引用的设置档已删除': 'The referenced profile was deleted',
  '声音条目已删除': 'The voice entry was deleted',
  '当前用户：{value}': 'Current user: {value}',
  '角色卡切换': 'Character Card Switch',
  '生成内容': 'Generate Content',
  '提示：可在女仆设置的 API 分页配置 sub-agent 模型，这类生成任务可交给便宜模型执行。': 'Tip: Configure a sub-agent model on the API tab in Maid Settings to delegate this type of generation task to a less expensive model.',
  '生成失败（含主模型回退）。': 'Generation failed, including the main-model fallback.',
  '生成失败。': 'Generation failed.',
  '当前图片模型不支持参考图': 'The current image model does not support reference images',
  '当前图片模型最多支持 {value} 张参考图': 'The current image model supports up to {value} reference images',
  '确认覆盖': 'Confirm Overwrite',
  '这个动作会覆盖已有内容。取消后将改为新建副本。': 'This action will overwrite existing content. Cancel to create a new copy instead.',
  '新建副本': 'Create a Copy',
  '无响应': 'No response',
  '图片请求失败（HTTP {value}）': 'Image request failed (HTTP {value})',
  '图片响应为空': 'The image response was empty',
  '请先在 API 配置中启用图片生成模型。': 'Enable an image-generation model in API settings first.',
  '这个动作会覆盖已有内容。': 'This action will overwrite existing content.',
  '本次请求未发送模型提示词。': 'No model prompt was sent for this request.',
  '确认危险操作': 'Confirm Risky Action',
  '这个动作可能会覆盖、删除或替换已有内容。': 'This action may overwrite, delete, or replace existing content.',
  '确认执行': 'Confirm',
  '允许一次': 'Allow Once',
  '动态评论生成失败': 'Failed to generate the Moment comment',
  '编辑思维链': 'Edit reasoning',
  '复制思维链': 'Copy reasoning',
  '更换开场白': 'Change greeting',
  '消息': 'Message',
  '查看回复原消息：{value}': 'View replied-to message: {value}',
  '[图片已过期]': '[Image expired]',
  '以下为未读讯息': 'Unread messages below',
  '对方': 'Chat Partner',
  '更换': 'Change',
  '序　幕': 'Prologue',
  '—— 幕 启 ——': '—— Curtain Rises ——',
};
for (const [source, translated] of Object.entries(appHighFrequencyTranslations)) {
  assert.ok(sources.has(source), `high-frequency app UI source key must be extracted: ${source}`);
  assert.equal(english[source], translated, `English translation must cover high-frequency app UI: ${source}`);
}
assert.deepEqual(english['Thought for {count} 秒'], {
  one: 'Thought for {count} second',
  other: 'Thought for {count} seconds',
});
assert.match(
  appSource,
  /el\.title\s*=\s*translateUiText\(`当前用户：\$\{name\}`\)/,
  'user-name title is below a DOM-localization skip selector and must be translated explicitly',
);
assert.match(appSource, /content:\s*translateUiText\('\[图片已过期\]'\)/);
assert.match(appSource, /content:\s*translateUiText\('以下为未读讯息'\)/);
assert.match(appSource, /return msgName \|\| translateUiText\('对方'\)/);
assert.match(
  appSource,
  /requestPrompt:\s*promptText\s*\|\|\s*translateUiText\('本次请求未发送模型提示词。'\)/,
  'prompt-preview empty state is below a DOM-localization skip selector and must be translated explicitly',
);

const chatUiStatusTranslations = {
  '生成新回复中...': 'Generating a new response...',
  '生成中...': 'Generating...',
  'Agent 工具权限缺少 pending id': 'Agent tool permission is missing a pending ID',
  'Agent 工具权限处理器未就绪': 'Agent tool permission handler is not ready',
  'Agent 工具已允许并执行': 'Agent tool was allowed and executed',
  'Agent 工具权限已允许，但本次未执行': 'Agent tool permission was allowed, but the tool was not run this time',
  'Agent 工具权限已允许': 'Agent tool permission allowed',
  'Agent 工具权限已拒绝': 'Agent tool permission denied',
  'Agent 工具权限处理失败': 'Failed to process Agent tool permission',
  'Agent Center 尚未就绪': 'Agent Center is not ready',
  '没有可查看的原始回复': 'No raw response is available to view',
  '原文查看器尚未就绪': 'Raw response viewer is not ready',
  '暂无可用的输入修改建议': 'No input revision suggestions are available',
  '已放入输入框，发送前可继续修改': 'Added to the input box; you can edit it before sending',
  '暂无可应用的格式修复候选': 'No format-repair candidate is available',
  '消息编辑处理器未就绪': 'Message edit handler is not ready',
  '格式修复候选缺少原始快照或行补丁，请重新检查': 'The format-repair candidate is missing its original snapshot or line patches. Run the check again.',
  '已取消格式修复': 'Format repair canceled',
  '修复候选与当前正文一致，无需应用': 'The repair candidate matches the current text; no changes are needed',
  '已应用格式修复': 'Format repair applied',
  '应用格式修复失败': 'Failed to apply format repair',
  '暂无可应用的正文优化候选': 'No body-optimization candidate is available',
  '优化候选与当前正文一致，无需应用': 'The optimization candidate matches the current text; no changes are needed',
  '已应用正文优化': 'Body optimization applied',
  '应用正文优化失败': 'Failed to apply body optimization',
  '重试处理器未就绪': 'Retry handler is not ready',
  '已打回并重试生成': 'Response rejected and generation retried',
  '重试生成失败': 'Failed to retry generation',
  '这个 Agent 操作尚未开放': 'This Agent action is not available yet',
  'Provider 继续预览缺少 pending id': 'Provider continuation preview is missing a pending ID',
  'Provider gate 处理器未就绪': 'Provider gate handler is not ready',
  'Provider runner gate 已关闭': 'Provider runner gate is closed',
  'Provider 继续预览处理器未就绪': 'Provider continuation preview handler is not ready',
  '需先允许并执行工具，才能预览 Provider 继续': 'Allow and run the tool before previewing Provider continuation',
  'Provider 继续预览已就绪，确认面板未可用': 'Provider continuation preview is ready, but the confirmation panel is unavailable',
  'Provider 继续预览已生成，runner gate 未就绪': 'Provider continuation preview was generated, but the runner gate is not ready',
  'Provider 继续执行失败': 'Provider continuation failed',
  'Provider 继续已接到上一条回复': 'Provider continuation was appended to the previous response',
  'Provider 继续已完成（预览）': 'Provider continuation completed (preview)',
  'Provider 继续未执行': 'Provider continuation was not run',
  'Provider 继续预览失败': 'Provider continuation preview failed',
};
for (const [source, translated] of Object.entries(chatUiStatusTranslations)) {
  assert.ok(sources.has(source), `chat UI status source key must be extracted: ${source}`);
  assert.equal(english[source], translated, `English translation must cover chat UI status: ${source}`);
}
assert.match(
  chatUiSource,
  /renderSwipeDraftPlaceholderCore\(target,\s*\{[\s\S]*?label:\s*translateUiText\(label\)/,
  'swipe placeholders are inside skipped message DOM and must translate before rendering',
);
assert.match(
  chatUiSource,
  /setSwipeRegenerating\(\{[\s\S]*?label:\s*translateUiText\(label\)/,
  'swipe regeneration labels are inside skipped message DOM and must translate before rendering',
);
const messageBubbleTranslations = {
  '图片加载失败': 'Image failed to load',
  '图片加载失败，请检查链接或网络': 'Image failed to load. Check the link or network connection.',
  '语音': 'Voice',
  '语音加载失败': 'Audio failed to load',
  '文件': 'File',
  '待播放': 'Ready to play',
  '无音频地址': 'No audio URL',
  '音乐': 'Music',
  '播放': 'Play',
  '暂停': 'Pause',
  '播放错误': 'Playback error',
  '音频加载/播放失败': 'Audio load/playback failed',
  '播放完畢': 'Playback finished',
  '无音频地址，播放失败': 'No audio URL; playback failed',
  '播放中': 'Playing',
  '播放失败': 'Playback failed',
  '已暂停': 'Paused',
  '转账': 'Transfer',
  '金额：{value}': 'Amount: {value}',
  '待确认': 'Pending approval',
  '确认收款': 'Confirm receipt',
  '已收款': 'Received',
  '已收款 {value}': 'Received {value}',
  '表情包加载失败': 'Sticker failed to load',
  '表情包：{value}': 'Sticker: {value}',
  '图片生成失败': 'Image generation failed',
  '重新生成图片': 'Regenerate image',
};
for (const [source, translated] of Object.entries(messageBubbleTranslations)) {
  assert.ok(sources.has(source), `message-card UI source key must be extracted: ${source}`);
  assert.equal(english[source], translated, `English translation must cover message-card UI: ${source}`);
}
const reactionTranslations = {
  '添加反应': 'Add reaction',
  '快捷表情反应': 'Quick emoji reactions',
  '使用{emoji}回应': 'React with {emoji}',
  '选择更多表情反应': 'Choose more emoji reactions',
  '选择表情反应': 'Choose an emoji reaction',
  '使用{emoji}回应，{label}': 'React with {emoji}, {label}',
  '关闭表情选择器': 'Close emoji picker',
  '表情分类': 'Emoji categories',
  '图': 'Image',
  '用「{voice}」朗读本条（仅本次）': 'Read this message with “{voice}” (this time only)',
  '查看代码': 'View code',
  '查看源码': 'View source',
  '以此生成图片': 'Generate an image from this',
  '取消回复': 'Cancel reply',
  '请选择要删除的消息': 'Select the messages to delete',
};
for (const [source, translated] of Object.entries(reactionTranslations)) {
  assert.ok(sources.has(source), `reaction/context UI source key must be extracted: ${source}`);
  assert.equal(english[source], translated, `English translation must cover reaction/context UI: ${source}`);
}
assert.deepEqual(english['{emoji} {count}个反应'], {
  one: '{emoji} · {count} reaction',
  other: '{emoji} · {count} reactions',
});
assert.equal(Object.keys(traditional).length, sources.size);
assert.equal(Object.keys(pseudo).length, sources.size);
assert.equal(traditional['⚙ 设置'], '⚙ 設定', '人工台湾术语必须在较长 UI 文案内覆盖 OpenCC 结果');
assert.equal(traditional['脚本选项'], '腳本選項');
assert.deepEqual(
  Object.keys(traditional),
  Object.keys(traditional).slice().sort((left, right) => left.localeCompare(right, 'zh-Hans-CN')),
  '生成目录键顺序必须稳定',
);

const sourceWithToken = sourceEntries.find(entry => /\{[a-zA-Z0-9_.-]+\}/.test(entry.source));
if (sourceWithToken) {
  const tokens = value => Array.from(value.matchAll(/\{[a-zA-Z0-9_.-]+\}/g), match => match[0]);
  assert.deepEqual(tokens(traditional[sourceWithToken.source]), tokens(sourceWithToken.source));
  assert.deepEqual(tokens(pseudo[sourceWithToken.source]), tokens(sourceWithToken.source));
}

for (const [source, value] of Object.entries(pseudo).slice(0, 100)) {
  assert.match(value, /^［.*］$/s, `伪本地化值缺少边界标记: ${source}`);
}

console.log('i18n-catalog-generation-tests passed');
