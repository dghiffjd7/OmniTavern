import assert from 'node:assert/strict';
import {
  buildAutoImagePromptInstruction,
  extractAutoImagePrompts,
  prepareAutoImagePromptPlaceholders,
  protectUnclosedAutoImagePromptTags,
  restoreProtectedAutoImagePromptTags,
  shouldAllowAutoImagePromptByRateLimit,
  stripMomentBlocksForAutoImagePrompt,
  stripAutoImagePromptTags,
} from '../../src/scripts/ui/chat/auto-image-prompt-utils.js';

{
  const prompts = extractAutoImagePrompts('正文\n<image_prompt>blue sky, girl, soft light</image_prompt>');
  assert.deepEqual(prompts, ['blue sky, girl, soft light']);
  console.log('ok - extracts image_prompt tag content');
}

{
  const prompts = extractAutoImagePrompts('&lt;image_prompt&gt;cinematic portrait&lt;/image_prompt&gt;');
  assert.deepEqual(prompts, ['cinematic portrait']);
  console.log('ok - extracts html escaped image_prompt tags');
}

{
  const stripped = stripAutoImagePromptTags('hello\n<image_prompt>secret prompt</image_prompt>\nworld');
  assert.equal(stripped.trim().replace(/\n{2,}/g, '\n'), 'hello\nworld');
  console.log('ok - strips image_prompt tags from display text');
}

{
  const source = '正文\n<image_prompt>\n后续正文';
  const protectedSource = protectUnclosedAutoImagePromptTags(source);
  assert.doesNotMatch(protectedSource.text, /<\s*image_prompt\b/i);
  assert.equal(restoreProtectedAutoImagePromptTags(protectedSource.text, protectedSource), source);
  console.log('ok - protects unclosed image_prompt open tags as plain text');
}

{
  const source = '正文\n<image_prompt>closed prompt</image_prompt>\n后续正文';
  const protectedSource = protectUnclosedAutoImagePromptTags(source);
  assert.equal(protectedSource.text, source);
  assert.equal(protectedSource.replacements.length, 0);
  console.log('ok - leaves closed image_prompt tags available for extraction');
}

{
  const source = '正文\n<image_prompt>\n后续正文';
  const prepared = prepareAutoImagePromptPlaceholders(source);
  assert.deepEqual(prepared.prompts, []);
  assert.equal(prepared.text, source);
  assert.equal(stripAutoImagePromptTags(source), source);
  console.log('ok - incomplete image_prompt tags are not stripped or extracted');
}

{
  const source = '<thought><image_prompt>draft only</thought>\n正文\n<image_prompt>visible</image_prompt>';
  const prompts = extractAutoImagePrompts(source, { max: 0, dedupe: false });
  const prepared = prepareAutoImagePromptPlaceholders(source);
  const stripped = stripAutoImagePromptTags(source);
  assert.deepEqual(prompts, ['visible']);
  assert.deepEqual(prepared.prompts.map(item => item.prompt), ['visible']);
  assert.equal(prepared.text, '<thought><image_prompt>draft only</thought>\n正文\n[img-图片生成中]');
  assert.equal(stripped.trim(), '<thought><image_prompt>draft only</thought>\n正文');
  console.log('ok - unclosed image_prompt before a later closed tag does not consume intervening text');
}

{
  const source = '<thinking><image_prompt>ignored</image_prompt></thinking>\n<image_prompt>visible</image_prompt>';
  const prepared = prepareAutoImagePromptPlaceholders(source);
  assert.deepEqual(prepared.prompts.map(item => item.prompt), ['visible']);
  assert.equal(prepared.text, '<thinking><image_prompt>ignored</image_prompt></thinking>\n[img-图片生成中]');
  console.log('ok - complete image_prompt tags inside known reasoning blocks are ignored by placeholder prep');
}

{
  const instruction = buildAutoImagePromptInstruction({
    uiMode: 'chat',
    isGroupChat: true,
    modelHint: 'openai / gpt-image-2',
    style: 'natural',
    decisionMode: 'conservative',
  });
  assert.doesNotMatch(instruction, /<auto_image_generation>/);
  assert.match(instruction, /^<generate_img_rule>/);
  assert.match(instruction, /<\/generate_img_rule>$/);
  assert.match(instruction, /<image_prompt>/);
  assert.match(instruction, /请严格按以下XML格式输出/);
  assert.match(instruction, /openai \/ gpt-image-2/);
  assert.match(instruction, /触发策略：保守/);
  assert.doesNotMatch(instruction, /<tableEdit>/);
  console.log('ok - builds auto image prompt instruction');
}

{
  const prompts = extractAutoImagePrompts('```xml\n<image_prompt>ignored</image_prompt>\n```\n<image_prompt>visible</image_prompt>');
  assert.deepEqual(prompts, ['visible']);
  console.log('ok - ignores image_prompt tags inside markdown code blocks');
}

{
  // 整篇回复被同一个代码块包住（如伪装成终端输出）时，这层只是外壳，里面的标签照常识别。
  const wrapped = '\n```bash\nuser@linux:~$ cat chapter_01.txt\n<content>\n正文\n<image_prompt>fairy</image_prompt>\n</content>\n```\n';
  assert.deepEqual(extractAutoImagePrompts(wrapped, { max: 10 }), ['fairy']);
  assert.deepEqual(extractAutoImagePrompts('~~~\n<image_prompt>tilde</image_prompt>\n~~~', { max: 10 }), ['tilde']);
  const prepared = prepareAutoImagePromptPlaceholders(wrapped, { max: 10 });
  assert.deepEqual(prepared.prompts.map(item => item.prompt), ['fairy']);
  assert.match(prepared.text, /^\n```bash\n[\s\S]*\[img-图片生成中\][\s\S]*\n```\n$/);
  // 前面有正文，或首尾是两个独立代码块时，仍按代码处理。
  assert.deepEqual(extractAutoImagePrompts('intro\n```\n<image_prompt>x</image_prompt>\n```', { max: 10 }), []);
  const twoBlocks = '```\n<image_prompt>a</image_prompt>\n```\nmiddle\n```\n<image_prompt>b</image_prompt>\n```';
  assert.deepEqual(extractAutoImagePrompts(twoBlocks, { max: 10 }), []);
  assert.deepEqual(prepareAutoImagePromptPlaceholders(twoBlocks, { max: 10 }).prompts, []);
  console.log('ok - reads image_prompt tags when the whole reply is one code block');
}

{
  const source = '<image_prompt>A</image_prompt>\n<image_prompt>B</image_prompt>\n<image_prompt>C</image_prompt>';
  const prepared = prepareAutoImagePromptPlaceholders(source, {
    max: 2,
    overflowTokenBuilder: ({ prompt, index, max }) => `[overflow-${index}-${max}-${prompt}]`,
  });
  assert.deepEqual(prepared.prompts.map(item => item.prompt), ['A', 'B']);
  assert.match(prepared.text, /\[img-图片生成中\]/);
  assert.match(prepared.text, /\[img-图片生成中 2\]/);
  assert.match(prepared.text, /\[overflow-2-2-C\]/);
  console.log('ok - prepares overflow tokens for image prompts beyond max');
}

{
  const source = '<image_prompt>A</image_prompt>\n<image_prompt>B</image_prompt>\n<image_prompt>C</image_prompt>';
  const prompts = extractAutoImagePrompts(source, { max: 0, dedupe: false });
  const prepared = prepareAutoImagePromptPlaceholders(source, { max: 0 });
  assert.deepEqual(prompts, ['A', 'B', 'C']);
  assert.deepEqual(prepared.prompts.map(item => item.prompt), ['A', 'B', 'C']);
  assert.equal(prepared.text.includes('[overflow'), false);
  console.log('ok - image prompt max 0 means unlimited');
}

{
  const prompts = extractAutoImagePrompts('<thinking><image_prompt>ignored</image_prompt></thinking>\n<image_prompt>visible</image_prompt>');
  assert.deepEqual(prompts, ['visible']);
  console.log('ok - ignores image_prompt tags inside reasoning blocks');
}

{
  const source = [
    '聊天正文',
    'moment_start',
    '阿兰--动态<image_prompt>moment image</image_prompt>--12:00--1--2',
    'moment_end',
    '<image_prompt>chat image</image_prompt>',
  ].join('\n');
  const stripped = stripMomentBlocksForAutoImagePrompt(source);
  assert.doesNotMatch(stripped, /moment image/);
  assert.match(stripped, /chat image/);
  const prompts = extractAutoImagePrompts(source, { stripMomentBlocks: true });
  assert.deepEqual(prompts, ['chat image']);
  console.log('ok - chat auto image extraction can ignore moment image tags');
}

{
  const instruction = buildAutoImagePromptInstruction({
    template: '{{image_prompt_position_rule}}\n<image_prompt>prompt</image_prompt>',
  });
  assert.doesNotMatch(instruction, /image_prompt_position_rule/);
  assert.doesNotMatch(instruction, /<tableEdit>/);
  assert.match(instruction, /^<generate_img_rule>/);
  assert.match(instruction, /<image_prompt>prompt<\/image_prompt>/);
  console.log('ok - removes legacy position placeholder from custom templates');
}

{
  const instruction = buildAutoImagePromptInstruction({
    template: '<generate_img_rule>\n<image_prompt>prompt</image_prompt>\n</generate_img_rule>',
  });
  assert.equal((instruction.match(/<generate_img_rule>/g) || []).length, 1);
  assert.equal((instruction.match(/<\/generate_img_rule>/g) || []).length, 1);
  console.log('ok - avoids double wrapping generate_img_rule templates');
}

{
  const instruction = buildAutoImagePromptInstruction({
    uiMode: 'rp',
    modelHint: 'gemini / nano banana',
    style: 'auto',
    template: 'surface={{image_prompt_surface}}\nmodel={{image_prompt_model}}\nstyle={{image_prompt_style}}\nwhere={{image_prompt_position_rule}}\ntag={{image_prompt_tag}}',
  });
  assert.match(instruction, /surface=创意写作插图/);
  assert.match(instruction, /model=gemini \/ nano banana/);
  assert.match(instruction, /where=/);
  assert.doesNotMatch(instruction, /若需要生成图片/);
  assert.match(instruction, /tag=image_prompt/);
  assert.match(instruction, /^<generate_img_rule>/);
  console.log('ok - renders custom preset auto image prompt template');
}

{
  const messages = [
    { id: 'a1', role: 'assistant', type: 'text', content: 'hello' },
    {
      id: 'img1',
      role: 'assistant',
      type: 'image',
      meta: {
        generatedMedia: {
          source: 'auto_image_prompt',
          sourceMessageId: 'a1',
          prompt: 'blue sky',
        },
      },
    },
    { id: 'a2', role: 'assistant', type: 'text', content: 'next' },
  ];
  const guard = shouldAllowAutoImagePromptByRateLimit({
    messages,
    settings: { autoImagePromptCooldownRounds: 2, autoImagePromptWindowRounds: 0, autoImagePromptWindowMax: 0 },
    nextAssistantTurn: true,
    checkRepeated: false,
  });
  assert.equal(guard.ok, false);
  assert.match(guard.reason, /cooldown-2/);
  console.log('ok - skips prompt injection during cooldown');
}

{
  const messages = [
    { id: 'a1', role: 'assistant', type: 'text', content: 'hello' },
    {
      id: 'img1',
      role: 'assistant',
      type: 'image',
      meta: {
        generatedMedia: {
          source: 'auto_image_prompt',
          sourceMessageId: 'a1',
          prompt: 'blue sky',
        },
      },
    },
  ];
  const guard = shouldAllowAutoImagePromptByRateLimit({
    messages,
    messageId: 'a1',
    prompt: ' blue   sky ',
    settings: { autoImagePromptSkipRepeated: true },
  });
  assert.equal(guard.ok, false);
  assert.equal(guard.reason, 'repeated-prompt');
  console.log('ok - skips repeated auto image prompts');
}
