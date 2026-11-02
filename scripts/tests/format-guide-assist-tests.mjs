import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const {
  buildFormatGuideAssistMessages,
  collectFormatGuideSources,
  normalizeFormatGuideSource,
  parseFormatGuideAssistResult,
  pickFormatParagraphs,
  removeFormatGuideItem,
  renderFormatGuideDraft,
  resolvePendingFormatGuideItem,
} = await import('../../src/scripts/agent/format-guide-assist.js');
const { createFormatGuideAssistRuntime } = await import('../../src/scripts/ui/chat/format-guide-assist-runtime.js');
const { formatRepairProfileConfig, resolveFormatRepairProfile } = await import('../../src/scripts/agent/format-repair-profiles.js');

const preset = {
  name: 'Kemini',
  prompts: [
    { identifier: 'main', name: '主提示', content: '你是故事讲述者。\n\n每次回复末尾输出 <status>…</status> 状态栏，字段为 地点、时间。' },
    { identifier: 'style', name: '文风', content: '文笔细腻，多用比喻。' },
    { identifier: 'off', name: '关掉的格式', content: '输出 <options> 选项。' },
    { identifier: 'chatHistory', name: 'Chat History', marker: true },
  ],
  prompt_order: [{ character_id: 100001, order: [
    { identifier: 'main', enabled: true }, { identifier: 'style', enabled: true }, { identifier: 'off', enabled: false }, { identifier: 'chatHistory', enabled: true },
  ] }],
};
const world = { name: '设定集', entries: { 0: { uid: 0, comment: '输出格式', content: '剧情需要选择时输出 <choice> 标签。' }, 1: { uid: 1, comment: '停用', content: '输出 <old>。', disable: true }, 2: { uid: 2, comment: '人物', content: '她有一头黑发。' } } };
const regexRules = [
  { id: 'r1', scriptName: '状态栏', findRegex: '^<status>([\\s\\S]*?)</status>$', replaceString: '【状态】$1', placement: [2] },
  { id: 'r2', scriptName: '隐藏思考', findRegex: '<think>[\\s\\S]*?</think>', replaceString: '', placement: [2] },
  { id: 'r3', scriptName: '用户输入', findRegex: 'foo', replaceString: 'bar', placement: [1] },
];

{
  assert.equal(pickFormatParagraphs('第一段讲人物。\n\n输出 <a> 标签。\n\n第三段。'), '输出 <a> 标签。');
  assert.equal(pickFormatParagraphs('只是剧情'), '');
  assert.equal(pickFormatParagraphs('<character_information>\n名称：林念初\n<user>的青梅竹马。\n</character_information>'), '', 'data wrapped in tags is not a format requirement');
  assert.equal(pickFormatParagraphs('回复末尾输出状态栏：\n\n<status>\n地点：\n</status>\n\n她有一头黑发。'), '回复末尾输出状态栏：\n\n<status>\n地点：\n</status>', 'template paragraphs come along when the source talks about output');
  assert.equal(pickFormatParagraphs('输出时注意：\n\n<user>说话时要自然。'), '输出时注意：', '<user> is a macro, not a tag');
  assert.ok(pickFormatParagraphs(`格式：${'x'.repeat(2000)}`, 100).endsWith('…'));
  console.log('ok - only format-related paragraphs are kept and clipped');
}

{
  const collected = collectFormatGuideSources({
    presets: [{ name: 'Kemini', preset }],
    worlds: [{ name: '设定集', world }],
    character: { name: '千夏', fields: { description: '千夏是学生。', system_prompt: '回复时用 <msg> 包住每句台词。' } },
    regexRules,
  });
  const byLabel = Object.fromEntries(collected.items.map(item => [item.label, item]));
  assert.deepEqual(collected.items.map(item => item.id), collected.items.map((_item, index) => `s${index + 1}`), 'short ids for the model');
  assert.ok(byLabel['预设「Kemini」· 主提示']?.text.includes('<status>'), 'enabled preset prompt with format text');
  assert.ok(!collected.items.some(item => /文风|关掉的格式|Chat History/.test(item.label)), 'no style-only, disabled or marker prompts');
  assert.ok(byLabel['角色卡「千夏」· 系统提示']?.text.includes('<msg>'));
  assert.ok(!collected.items.some(item => item.label.includes('描述')), 'character fields without format text are skipped');
  assert.ok(byLabel['世界书「设定集」· 输出格式']);
  assert.ok(!collected.items.some(item => /停用|人物/.test(item.label)), 'disabled and non-format entries are skipped');
  assert.equal(byLabel['正则「状态栏」']?.text, '结构：<status>...</status>', 'regex gives structure evidence only');
  assert.deepEqual([collected.regexEvidenceCount, collected.regexSkippedCount], [1, 1], 'cleanup regex is counted, user-input regex is not');
  assert.ok(collected.fingerprint);
  const changed = collectFormatGuideSources({ presets: [{ name: 'Kemini', preset: { ...preset, prompts: preset.prompts.map(p => p.identifier === 'main' ? { ...p, content: `${p.content}\n\n再输出 <mood> 标签。` } : p) } }], worlds: [{ name: '设定集', world }], regexRules });
  assert.notEqual(changed.fingerprint, collected.fingerprint, 'the fingerprint follows source text');
  const many = collectFormatGuideSources({ worlds: [{ name: '大', world: { entries: Array.from({ length: 40 }, (_v, i) => ({ uid: i, comment: `e${i}`, content: `输出格式 ${'x'.repeat(900)}` })) } }] });
  assert.ok(many.items.length < 40 && many.omittedCount > 0, 'the total size is capped');
  console.log('ok - sources come from enabled preset prompts, character fields, worldbook entries and regex structure');
}

{
  const sources = [{ id: 's1', label: '预设「K」· 主提示', text: '输出 <status>' }];
  const [system, user] = buildFormatGuideAssistMessages({ sources, locale: 'en' });
  assert.match(system.content, /只输出 JSON/);
  assert.match(system.content, /用English书写/);
  assert.match(user.content, /^\[s1\] 预设「K」· 主提示\n输出 <status>/);
  const [exampleSystem, exampleUser] = buildFormatGuideAssistMessages({ mode: 'example', example: '<status>地点：学校</status>', note: '保留状态栏' });
  assert.match(exampleSystem.content, /示例值/);
  assert.match(exampleUser.content, /\[example\][\s\S]*<status>地点：学校<\/status>[\s\S]*说明：保留状态栏/);
  console.log('ok - assist prompts carry labeled sources or the example with its note');
}

{
  const raw = '```json\n{"required":[{"rule":"末尾输出 <status> 状态栏","sources":["s1","s9"]},{"rule":"  ","sources":[]}],"conditional":[{"rule":"<choice> 选项","when":"需要选择时","sources":["s2"]}],"order":[],"pending":[{"rule":"<mood> 是否每次都有","reason":"只在正则里","sources":["s3"]}]}\n```';
  const draft = parseFormatGuideAssistResult(raw, { sourceIds: ['s1', 's2', 's3'] });
  assert.deepEqual(draft.required, [{ rule: '末尾输出 <status> 状态栏', sources: ['s1'] }], 'unknown source ids and empty rules are dropped');
  assert.equal(draft.conditional[0].when, '需要选择时');
  assert.equal(draft.pending[0].reason, '只在正则里');
  assert.throws(() => parseFormatGuideAssistResult('无法整理'), /有效的 JSON/);

  const labels = { s1: '预设「K」', s2: '世界书「设定集」', s3: '正则「心情」' };
  const text = renderFormatGuideDraft(draft, { labelOf: id => labels[id] });
  assert.equal(text, [
    '必须有：',
    '- 末尾输出 <status> 状态栏（来源：预设「K」）',
    '',
    '按条件出现：',
    '- <choice> 选项（需要选择时）（来源：世界书「设定集」）',
    '',
    '待确认（检查时不当作必须）：',
    '- <mood> 是否每次都有（只在正则里）（来源：正则「心情」）',
  ].join('\n'));

  const promoted = resolvePendingFormatGuideItem(draft, 0, 'conditional');
  assert.equal(promoted.pending.length, 0);
  assert.deepEqual(promoted.conditional[1], { rule: '<mood> 是否每次都有', when: '', sources: ['s3'] });
  assert.equal(resolvePendingFormatGuideItem(draft, 0, 'required').required.length, 2);
  assert.equal(removeFormatGuideItem(draft, 'required', 0).required.length, 0);
  assert.equal(removeFormatGuideItem(draft, 'nope', 0), draft);
  console.log('ok - model JSON is parsed, rendered as a readable draft, and pending items can be resolved');
}

{
  assert.equal(normalizeFormatGuideSource(null), null);
  assert.equal(normalizeFormatGuideSource({ mode: 'other' }), null);
  assert.deepEqual(normalizeFormatGuideSource({ mode: 'sources', fingerprint: 'abc', at: 5 }), { mode: 'sources', fingerprint: 'abc', at: 5 });
  assert.deepEqual(normalizeFormatGuideSource({ mode: 'example', fingerprint: 'abc' }), { mode: 'example', fingerprint: '', at: 0 });
  const profile = formatRepairProfileConfig({ formatGuide: 'x', formatGuideSource: { mode: 'sources', fingerprint: 'f', at: 1 } });
  assert.deepEqual(profile.formatGuideSource, { mode: 'sources', fingerprint: 'f', at: 1 }, 'repair profiles keep the draft source');
  const resolved = resolveFormatRepairProfile({ id: 'reply_check', formatGuide: '', repairProfiles: { version: 1, automaticId: 'a', items: [{ id: 'a', name: 'A', config: profile }] } }, 'a');
  assert.equal(resolved.formatGuideSource.fingerprint, 'f');
  console.log('ok - the draft source survives repair profile save and load');
}

{
  const calls = [];
  const runtime = createFormatGuideAssistRuntime({
    presetStore: { getResolvedActive: (type, context) => { calls.push(['preset', type, context.uiMode]); return { presetId: 'Kemini', preset }; } },
    regexStore: { computeActiveRules: () => regexRules },
    contactsStore: { getContact: () => null },
    getUiMode: () => 'rp',
    getResolvedWorldState: () => ({ worldIds: ['设定集', '设定集', 'missing'] }),
    getWorldInfo: async id => (id === '设定集' ? world : null),
    getCharacter: () => ({ name: '千夏', fields: { system_prompt: '回复时用 <msg> 包住台词。' } }),
    createModelRequest: (config, sid) => ({
      chat: async (messages, options) => {
        calls.push(['chat', config.modelMode, sid, options.temperature, messages.length]);
        return '{"required":[{"rule":"输出 <status>","sources":["s1"]}],"conditional":[],"order":[],"pending":[]}';
      },
    }),
  });
  const collected = await runtime.collectSources({ sessionId: 'rp:persona_1' });
  assert.equal(collected.items.filter(item => item.label.startsWith('世界书')).length, 1, 'duplicate and missing worlds are skipped');
  await assert.rejects(runtime.draft({ sessionId: 'rp:persona_1', config: { modelMode: 'none' } }), /请先选择连线配置/);
  await assert.rejects(runtime.draft({ sessionId: 'rp:persona_1', mode: 'example', config: { modelMode: 'follow_current' }, example: '  ' }), /正常回复/);
  const result = await runtime.draft({ sessionId: 'rp:persona_1', config: { modelMode: 'profile', modelProfileId: 'p' } });
  assert.deepEqual(result.draft.required, [{ rule: '输出 <status>', sources: ['s1'] }]);
  assert.equal(result.fingerprint, collected.fingerprint);
  assert.deepEqual(calls.find(call => call[0] === 'chat'), ['chat', 'profile', 'rp:persona_1', 0.2, 2]);
  const exampleResult = await runtime.draft({ sessionId: 'rp:persona_1', mode: 'example', config: { modelMode: 'follow_current' }, example: '<status>x</status>' });
  assert.deepEqual([exampleResult.mode, exampleResult.fingerprint, exampleResult.sources.length], ['example', '', 0]);
  console.log('ok - the runtime collects session sources and drafts with the agent connection');
}

console.log('format-guide-assist-tests passed');
