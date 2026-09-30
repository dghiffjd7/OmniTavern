import assert from 'node:assert/strict';

import {
  canonicalizeOfficialPromptRecord,
  getLocalizedPromptText,
  localizeOfficialPromptRecord,
  setPromptLocale,
} from '../../src/scripts/i18n/prompt-locale.js';
import { buildAutoImagePromptInstruction } from '../../src/scripts/ui/chat/auto-image-prompt-utils.js';
import { buildChatFormatGuardianModelPrompt } from '../../src/scripts/ui/chat/chat-format-guardian-utils.js';
import {
  buildMomentCommentGroupList,
  buildMomentCommentPromptData,
  buildMomentCommentSideEffectInstructions,
} from '../../src/scripts/ui/chat/moments-runtime-utils.js';
import { buildChatFormatGuardianRetryInstruction } from '../../src/scripts/ui/chat/after-receive-dispatch-utils.js';
import {
  buildSummaryCompactionContext,
  buildSummaryCompactionPrompt,
  isValidCompactedSummaryText,
} from '../../src/scripts/ui/chat/summary-compaction-utils.js';
import { buildMaidSelectionPromptBlock } from '../../src/scripts/ui/maid-selection-utils.js';
import { buildMaidRunResumePrompt } from '../../src/scripts/ui/maid-run-resume-utils.js';
import { buildMemoryUpdateRequest } from '../../src/scripts/ui/chat/memory-update-runtime-utils.js';
import { buildRealtimeSemanticSnapshotFromRequest } from '../../src/scripts/ui/realtime/realtime-context-builder.js';
import {
  buildWorldAiMessages,
  buildWorldbookEntryGenerationPrompt,
} from '../../src/scripts/utils/world-ai-generation.js';
import { buildChatBodyOptimizeModelPrompt } from '../../src/scripts/ui/chat/chat-body-optimize-utils.js';
import {
  DEFAULT_MAID_PROMPT,
  canonicalizeMaidPrompt,
  getLocalizedMaidOperationSafetyPrompt,
  getLocalizedMaidOutputLanguagePrompt,
  getLocalizedMaidPrompt,
} from '../../src/scripts/agent/maid-prompt-defaults.js';

globalThis.localStorage ||= {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
const { localizeVariableAiEvaluationPrompt } = await import(
  '../../src/scripts/variables/variable-rule-engine.js'
);
const {
  PresetStore,
  getCanonicalBuiltinPromptDefaults,
} = await import('../../src/scripts/storage/preset-store.js');

const defaults = getCanonicalBuiltinPromptDefaults();

setPromptLocale('en');
assert.match(getLocalizedPromptText('dialogue_rules', defaults.dialogue_rules), /Roleplay Core/);
assert.match(getLocalizedPromptText('phone_format_chat_rules', defaults.phone_format_chat_rules), /QQ Chat Format Guide/);
assert.match(getLocalizedPromptText('summary_rules', defaults.summary_rules), /summary must be written in English/);
assert.doesNotMatch(getLocalizedPromptText('summary_rules', defaults.summary_rules), /\p{Script=Han}/u);
assert.match(getLocalizedMaidPrompt(DEFAULT_MAID_PROMPT), /maid assistant inside this app/);
assert.match(getLocalizedMaidOperationSafetyPrompt(), /non-destructive actions/);
assert.match(getLocalizedMaidOutputLanguagePrompt(), /every user-visible response in English/);
assert.doesNotMatch(getLocalizedMaidOutputLanguagePrompt(), /\p{Script=Han}/u);
assert.match(getLocalizedPromptText('format_repair.fixed_preview'), /Fixed check instructions/);
assert.match(getLocalizedPromptText('sticker_ai.sprite_template'), /6×6 sprite sheet/);
assert.doesNotMatch(getLocalizedPromptText('sticker_ai.sprite_template'), /\p{Script=Han}/u);
assert.equal(
  getLocalizedPromptText('sticker_ai.generate_request_intro'),
  'Use the template wrapped in <prompt> and the user input wrapped in <input>:',
);
assert.equal(getLocalizedPromptText('sticker_ai.summary.subject'), 'Subject');
assert.match(getLocalizedPromptText('attachment.unreadable'), /could not be read/i);
assert.match(getLocalizedPromptText('body_optimize.retry.invalid_json'), /exactly one complete JSON object/i);
const summaryCompactionPrompt = buildSummaryCompactionPrompt({ payload: '- [12:00] Event' });
assert.match(summaryCompactionPrompt, /\[Key Events\]/);
assert.doesNotMatch(summaryCompactionPrompt, /\p{Script=Han}/u);
assert.equal(buildSummaryCompactionContext().meta.overrideLastUserMessage, 'Start the summary. Do not use the chat format.');
assert.equal(isValidCompactedSummaryText('[Key Events]\n• Event: Description'), true);
const maidSelectionPrompt = buildMaidSelectionPromptBlock([{
  type: 'element',
  semanticSummary: 'Agent Center card',
  text: 'Format check',
  messageId: 'm1',
  regionId: 'r1',
  viewportRect: { left: 0, top: 0, width: 20, height: 20 },
}]);
assert.match(maidSelectionPrompt, /UI element/);
assert.match(maidSelectionPrompt, /Message ID: m1/);
assert.doesNotMatch(maidSelectionPrompt, /\p{Script=Han}/u);
assert.doesNotMatch(buildMaidRunResumePrompt({ id: 'run-1', title: 'Review' }), /\p{Script=Han}/u);
assert.doesNotMatch(buildMemoryUpdateRequest({ historyText: 'User: hello' }).userText, /\p{Script=Han}/u);
const realtimeContext = buildRealtimeSemanticSnapshotFromRequest({
  messages: [
    { role: 'system', content: 'Stay kind.' },
    { role: 'user', content: 'Hello.' },
  ],
}).instructions;
assert.match(realtimeContext, /\[Recent Conversation\]/);
assert.doesNotMatch(realtimeContext, /\p{Script=Han}/u);
const worldAiPrompt = buildWorldAiMessages('', '')[0].content;
assert.match(worldAiPrompt, /Generate a complete character-lorebook entry/);
assert.doesNotMatch(worldAiPrompt, /\p{Script=Han}/u);
const worldEntryPrompt = buildWorldbookEntryGenerationPrompt({
  worldbookName: 'World',
  title: 'Entry',
  outline: 'Outline',
});
assert.match(worldEntryPrompt, /Write an entry for the lorebook/);
assert.doesNotMatch(worldEntryPrompt, /\p{Script=Han}/u);
const bodyOptimizePrompt = buildChatBodyOptimizeModelPrompt({ originalText: 'A sentence.' });
assert.match(bodyOptimizePrompt.messages[0].content, /body-text optimization agent/);
assert.doesNotMatch(bodyOptimizePrompt.messages.map(item => item.content).join('\n'), /\p{Script=Han}/u);
assert.equal(
  localizeVariableAiEvaluationPrompt('根据本轮对话判断好感度变化（-5~+5 之间的整数，只输出数字）。'),
  'Evaluate the change in affinity from this turn. Output only an integer from -5 to +5.',
);
assert.equal(localizeVariableAiEvaluationPrompt('Return a score from 1 to 3.'), 'Return a score from 1 to 3.');
assert.equal(canonicalizeMaidPrompt(getLocalizedMaidPrompt(DEFAULT_MAID_PROMPT)), DEFAULT_MAID_PROMPT);
assert.equal(getLocalizedMaidPrompt('Custom maid prompt'), 'Custom maid prompt');

const voiceDefault = getLocalizedMaidPrompt(DEFAULT_MAID_PROMPT, { voiceConversation: true });
const voiceSafety = getLocalizedMaidOperationSafetyPrompt({ voiceConversation: true });
const voiceConversation = getLocalizedPromptText('maid.voice.conversation');
assert.match(voiceDefault, /maid persona/);
assert.doesNotMatch(voiceDefault, /explain the status of app operations/);
assert.equal(getLocalizedMaidPrompt(getLocalizedMaidPrompt(DEFAULT_MAID_PROMPT), { voiceConversation: true }), voiceDefault);
assert.equal(getLocalizedMaidPrompt(`${DEFAULT_MAID_PROMPT}\nCustom persona`, { voiceConversation: true }), `${DEFAULT_MAID_PROMPT}\nCustom persona`);
assert.match(voiceSafety, /current permission request/);
assert.match(voiceSafety, /affected scope and permission purpose/);
assert.match(voiceSafety, /stays enabled until the user disables it in settings/);
assert.doesNotMatch(voiceSafety, /before execution/);
assert.match(voiceConversation, /continue the user's topic/);
assert.match(voiceConversation, /use status to check specific progress/);
assert.match(voiceConversation, /Without a real result for this task, do not claim completion/);
assert.doesNotMatch([voiceDefault, voiceSafety, voiceConversation].join('\n'), /\p{Script=Han}/u);

const localized = localizeOfficialPromptRecord({
  dialogue_rules: defaults.dialogue_rules,
  group_rules: defaults.group_rules,
  custom: '用户自定义内容',
}, defaults);
assert.match(localized.dialogue_rules, /Roleplay Core/);
assert.match(localized.group_rules, /Group Chat Scenario Prompt/);
assert.equal(localized.custom, '用户自定义内容');

const customDialogue = `${defaults.dialogue_rules}\n用户追加规则`;
assert.equal(
  localizeOfficialPromptRecord({ dialogue_rules: customDialogue }, defaults).dialogue_rules,
  customDialogue,
  '只允许精确的官方默认值随语言切换',
);

const canonicalized = canonicalizeOfficialPromptRecord(localized, defaults);
assert.equal(canonicalized.dialogue_rules, defaults.dialogue_rules);
assert.equal(canonicalized.group_rules, defaults.group_rules);
assert.equal(canonicalized.custom, '用户自定义内容');

const store = Object.create(PresetStore.prototype);
store.state = {
  presets: {
    sysprompt: {
      default: { name: 'Default', dialogue_rules: defaults.dialogue_rules },
      custom: { name: 'Custom', dialogue_rules: customDialogue },
    },
  },
  active: { sysprompt: 'default' },
  builtinActive: { sysprompt: 'default' },
  enabled: { sysprompt: true },
  bindings: {},
};
assert.match(store.getActive('sysprompt').dialogue_rules, /Roleplay Core/);
assert.equal(store.list('sysprompt').find(item => item.id === 'custom').dialogue_rules, customDialogue);

const englishDefault = store.getActive('sysprompt');
const savedId = store.applyUpsert('sysprompt', {
  id: 'default',
  name: 'Default',
  data: englishDefault,
  makeActive: false,
});
assert.equal(savedId, 'default');
assert.equal(store.state.presets.sysprompt.default.dialogue_rules, defaults.dialogue_rules);

const imagePrompt = buildAutoImagePromptInstruction({
  uiMode: 'rp',
  modelHint: '',
  style: 'natural',
  decisionMode: 'standard',
});
assert.match(imagePrompt, /Creative Writing illustration/);
assert.match(imagePrompt, /Natural-language prompt/);
assert.match(imagePrompt, /Trigger policy: standard/);
assert.doesNotMatch(imagePrompt, /创意写作插图|自然语言提示词|触发策略/);
assert.match(imagePrompt, /<image_prompt>/);

const guardianPrompt = buildChatFormatGuardianModelPrompt({
  assistantText: 'Alice--Hello--12:00',
  enabledFormats: {
    phoneShell: true,
    privateChat: true,
    imagePrompt: true,
    tableEdit: true,
  },
  parserReport: { status: 'no_events', repairFallbackTime: '12:00' },
  userName: 'User',
  sessionLabel: 'Alice',
});
assert.match(guardianPrompt.messages[0].content, /format-repair agent/i);
const guardianExplanatoryText = guardianPrompt.messages
  .map(item => item.content)
  .join('\n')
  .replace(/<[^>]+>/g, '');
assert.doesNotMatch(guardianExplanatoryText, /\p{Script=Han}/u);
const guardianRetry = buildChatFormatGuardianRetryInstruction({
  raw: '{}',
  review: { validationErrors: [{ code: 'shape', message: 'bad shape' }] },
});
assert.match(guardianRetry, /previous result failed app validation/i);
assert.doesNotMatch(guardianRetry, /\p{Script=Han}/u);

const momentSideEffects = buildMomentCommentSideEffectInstructions({ userName: 'User' });
const momentData = buildMomentCommentPromptData({
  authorName: 'Alice',
  content: 'A photo',
  time: '12:00',
  userLine: 'User: Nice!',
  contactList: '- Alice',
  groupList: buildMomentCommentGroupList({
    listContacts: () => [{ id: 'group:1', name: 'Friends', isGroup: true, members: [] }],
    getContact: () => null,
  }),
  sideEffectInstructions: momentSideEffects,
});
const momentExplanatoryText = momentData.replace(/<[^>]+>/g, '');
assert.match(momentExplanatoryText, /Available Contacts/);
assert.doesNotMatch(momentExplanatoryText, /\p{Script=Han}/u);

setPromptLocale('zh-TW');
assert.match(getLocalizedPromptText('dialogue_rules', defaults.dialogue_rules), /角色扮演核心/);
assert.match(getLocalizedPromptText('dialogue_rules', defaults.dialogue_rules), /嚴格遵循/);
assert.match(getLocalizedPromptText('time_context.template'), /當前真實時間/);
assert.doesNotMatch(getLocalizedPromptText('time_context.template'), /真即/);

setPromptLocale('zh-CN');
assert.equal(getLocalizedPromptText('dialogue_rules', defaults.dialogue_rules), defaults.dialogue_rules);
assert.match(getLocalizedPromptText('maid.voice.conversation'), /交办后接着聊用户刚才的话题/);
assert.match(getLocalizedPromptText('maid.voice.conversation'), /没有本次任务的真实结果，就不说完成/);
assert.match(getLocalizedMaidOperationSafetyPrompt({ voiceConversation: true }), /收到当前权限请求后/);

console.log('prompt-locale-tests passed');
