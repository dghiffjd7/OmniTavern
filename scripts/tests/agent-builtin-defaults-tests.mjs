import assert from 'node:assert/strict';
import { getBuiltinAgentTask, resolveBuiltinAgentTask, shouldAddInputSuggestionContract } from '../../src/scripts/agent/agent-builtin-defaults.js';
import { buildConfigurableInputMessages } from '../../src/scripts/agent/agent-request-builder.js';
import { buildChatFormatGuardianModelPrompt } from '../../src/scripts/ui/chat/chat-format-guardian-utils.js';
import { setPromptLocale } from '../../src/scripts/i18n/prompt-locale.js';

// Merely displaying/copying a default task must not add a duplicate output
// contract or optional reference material to the existing cursor-only request.
const before = 'b'.repeat(2600), after = 'a'.repeat(800);
const defaultInput = buildConfigurableInputMessages({ before, after });
assert.equal(defaultInput.length, 2);
assert.equal(defaultInput[0].content, getBuiltinAgentTask('text_completion'));
assert.deepEqual(JSON.parse(defaultInput.at(-1).content), { before: before.slice(-2400), after: after.slice(0, 600) });
for (const prompt of ['', '  ', getBuiltinAgentTask('text_completion')]) {
  assert.deepEqual(buildConfigurableInputMessages({ before, after, settings: { prompt, taskPromptMode: 'replace' } }), defaultInput);
  assert.equal(shouldAddInputSuggestionContract({ prompt }), false);
}
const customInput = buildConfigurableInputMessages({ before, settings: { prompt: 'Continue with one gentle sentence.' } });
assert.equal(customInput[0].content, 'Continue with one gentle sentence.');
assert.equal(customInput.length, 3);
assert.match(customInput[1].content, /Return only the short continuation/);
assert.equal(shouldAddInputSuggestionContract({ blocks: [{ enabled: false, text: 'disabled' }, { text: '  ' }] }), false);
assert.equal(shouldAddInputSuggestionContract({ blocks: [{ enabled: true, text: 'Use a warm tone.' }] }), true);

const formatOptions = {
  assistantText: '<tableEdit>updateRow(0,0,{"1":"unchanged payload"})</tableEdit>',
  enabledFormats: { tableEdit: true },
  customFormatGuide: 'Keep a closed tableEdit block.',
  formatReminderText: 'End with the required status block.',
  parserReport: { status: 'needs_review', warnings: ['MISSING_STATUS'], eventDrafts: [] },
  baseRevision: 'builtin-default-test',
};
setPromptLocale('zh-CN');
const defaultFormat = buildChatFormatGuardianModelPrompt(formatOptions);
assert.equal(defaultFormat.messages.length, 2);
assert.deepEqual(buildChatFormatGuardianModelPrompt({ ...formatOptions, agentConfig: { prompt: '', taskPromptMode: 'replace' } }), defaultFormat);
assert.deepEqual(buildChatFormatGuardianModelPrompt({ ...formatOptions, agentConfig: { prompt: getBuiltinAgentTask('reply_check'), taskPromptMode: 'replace' } }), defaultFormat);
assert.ok(defaultFormat.messages.at(-1).content.includes('unchanged payload'));
assert.ok(defaultFormat.messages.at(-1).content.includes('MISSING_STATUS'));
assert.ok(defaultFormat.messages.at(-1).content.includes('Keep a closed tableEdit block.'));
assert.ok(defaultFormat.messages.at(-1).content.includes('End with the required status block.'));

// Previously saved format tasks were additive. Reading/displaying them retains
// the original default rules and their extra task as an independent message.
const legacyConfig = { prompt: 'Prefer repairing the status header first.' };
const legacy = buildChatFormatGuardianModelPrompt({ ...formatOptions, agentConfig: legacyConfig });
assert.equal(legacy.messages[0].content, defaultFormat.messages[0].content);
assert.equal(legacy.messages[1].content, legacyConfig.prompt);
assert.equal(resolveBuiltinAgentTask(legacyConfig, 'reply_check'), `${getBuiltinAgentTask('reply_check')}\n\n${legacyConfig.prompt}`);
const editedLegacy = { prompt: resolveBuiltinAgentTask(legacyConfig, 'reply_check'), taskPromptMode: 'replace' };
const migrated = buildChatFormatGuardianModelPrompt({ ...formatOptions, agentConfig: editedLegacy });
assert.equal(migrated.messages.length, 2);
assert.equal(migrated.messages[0].content.split(legacyConfig.prompt).length - 1, 1, 'explicit edit preserves an old additional task exactly once');

// Editing the visible task changes the actual system instructions without
// removing patch validation, scene rules or the original read-only payload.
const customTask = 'Inspect the required headings and repair missing closing tags.';
const replacement = buildChatFormatGuardianModelPrompt({ ...formatOptions, agentConfig: { prompt: customTask, taskPromptMode: 'replace' } });
assert.ok(replacement.messages[0].content.includes(customTask), 'custom task follows the shared timestamp policy');
assert.doesNotMatch(replacement.messages[0].content, /你是聊天回复格式修复 Agent/);
assert.match(replacement.messages[0].content, /format_patch\.v1/);
assert.match(replacement.messages[0].content, /禁止输出 correctedText/);
assert.match(replacement.messages[0].content, /originalLines/);
assert.match(replacement.messages[0].content, /载荷必须逐字保持不变/);
assert.equal(replacement.messages.at(-1).content, defaultFormat.messages.at(-1).content);
assert.equal(replacement.sections.length, replacement.messages.length);

// Defaults follow the existing prompt locale at read time. A user's explicit
// task keeps its authored language across locale changes.
const chineseDefault = getBuiltinAgentTask('reply_check');
setPromptLocale('en');
assert.notEqual(getBuiltinAgentTask('reply_check'), chineseDefault);
assert.doesNotMatch(getBuiltinAgentTask('reply_check'), /\p{Script=Han}/u);
assert.equal(resolveBuiltinAgentTask({ prompt: customTask, taskPromptMode: 'replace' }, 'reply_check'), customTask);
assert.ok(buildChatFormatGuardianModelPrompt().messages[0].content.includes(getBuiltinAgentTask('reply_check').split('\n')[0]));
setPromptLocale('zh-CN');
console.log('agent builtin defaults tests passed');
