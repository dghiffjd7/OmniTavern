import assert from 'node:assert/strict';

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import {
  buildStandaloneSummaryCompactionMessages,
  buildSummaryCompactionContext,
  buildSummaryCompactionPayload,
  buildSummaryCompactionPrompt,
  extractSummaryTagText,
  getDefaultSummaryCompactionRules,
  isValidCompactedSummaryText,
  normalizeSummarySnapshotItems,
  parseSummaryCompactionResult,
  requestSummaryCompactionRaw,
  shouldRunSummaryCompaction,
} from '../../src/scripts/ui/chat/summary-compaction-utils.js';

{
  const prompt = buildSummaryCompactionPrompt({
    payload: '- [time] foo',
    compactedText: 'old summary',
  });
  assert.match(prompt, /【已有大总结】/);
  assert.match(prompt, /old summary/);
  assert.match(prompt, /【前文内容（按时间标注的摘要列表）】/);
  assert.match(prompt, /- \[time\] foo/);
  console.log('ok - buildSummaryCompactionPrompt includes prior compacted summary and payload');
}

{
  // 大总结每次都会把旧的大总结再折叠一遍，提示里要有字数上限，否则会越压越长。
  const prompt = buildSummaryCompactionPrompt({ payload: '- 摘要一', compactedText: '旧大总结' });
  assert.match(prompt, /总结全文控制在 800 字以内/);
  assert.ok(prompt.indexOf('800 字以内') < prompt.indexOf('</summary_rules>'));
  console.log('ok - buildSummaryCompactionPrompt caps compacted summary length');
}

{
  const payload = buildSummaryCompactionPayload([
    { text: '第一条', at: 1 },
    '第二条',
    { text: '   ' },
  ]);
  assert.match(payload, /- \[.*\] 第一条/);
  assert.match(payload, /- 第二条/);
  console.log('ok - buildSummaryCompactionPayload formats timeline items and skips empties');
}

{
  const ctx = buildSummaryCompactionContext({
    activeUser: {
      name: '我',
      description: 'desc',
      position: 'pos',
      depth: 2,
      role: 'role',
    },
    sessionId: 'group:1',
    characterName: '群聊A',
    isGroup: true,
    groupMembers: ['u1', 'u2'],
    groupMemberNames: ['甲', '乙'],
  });
  assert.deepEqual(ctx.session, { id: 'group:1', isGroup: true });
  assert.deepEqual(ctx.group, {
    id: 'group:1',
    name: '群聊A',
    members: ['u1', 'u2'],
    memberNames: ['甲', '乙'],
  });
  assert.equal(ctx.user.name, '我');
  assert.equal(ctx.meta.overrideLastUserMessage, '开始总结，勿输出聊天格式');
  console.log('ok - buildSummaryCompactionContext builds chat and group prompt context');
}

{
  const items = normalizeSummarySnapshotItems([
    ' 第一条 ',
    { text: '第二条', at: 42 },
    { text: '   ' },
    null,
  ]);
  assert.deepEqual(items, [
    { at: 0, text: '第一条' },
    { at: 42, text: '第二条' },
  ]);
  console.log('ok - normalizeSummarySnapshotItems trims empty entries and keeps timestamps');
}

{
  assert.equal(shouldRunSummaryCompaction({ items: [], force: false }), false);
  assert.equal(shouldRunSummaryCompaction({ items: ['x'.repeat(1000)], force: false }), false);
  assert.equal(shouldRunSummaryCompaction({ items: ['x'.repeat(1001)], force: false }), true);
  assert.equal(shouldRunSummaryCompaction({ items: [''], force: true }), true);
  console.log('ok - shouldRunSummaryCompaction respects threshold and force override');
}

{
  let builtArgs = null;
  let backgroundArgs = null;
  const raw = await requestSummaryCompactionRaw({
    items: [{ text: '摘要', at: 1 }],
    compactedText: '旧总结',
    context: { session: { id: 's1' } },
    buildMessages: (prompt, context) => {
      builtArgs = { prompt, context };
      return [{ role: 'user', content: prompt }];
    },
    backgroundChat: async (messages, options) => {
      backgroundArgs = { messages, options };
      return '  <summary>【关键事件】\n• 一: 二</summary>  ';
    },
  });
  assert.match(builtArgs?.prompt || '', /旧总结/);
  assert.deepEqual(builtArgs?.context, { session: { id: 's1' } });
  assert.equal(Array.isArray(backgroundArgs?.messages), true);
  // 两种写法都要带：预设的 max_tokens 会盖过驼峰 maxTokens
  assert.deepEqual(backgroundArgs?.options, { temperature: 0.2, maxTokens: 2000, max_tokens: 2000 });
  assert.equal(raw, '<summary>【关键事件】\n• 一: 二</summary>');
  console.log('ok - requestSummaryCompactionRaw builds prompt, messages, and trims response');
}

{
  // 调用方带的 signal 等选项保留，但不能把上限放大
  let options = null;
  await requestSummaryCompactionRaw({
    items: [{ text: '摘要', at: 1 }],
    buildMessages: prompt => [{ role: 'user', content: prompt }],
    backgroundChat: async (_messages, opts) => { options = opts; return 'x'; },
    options: { signal: 'sig', temperature: 0.2, maxTokens: 30000, max_tokens: 30000, presetContext: { sessionId: 's1' } },
  });
  assert.equal(options.signal, 'sig');
  assert.deepEqual(options.presetContext, { sessionId: 's1' });
  assert.equal(options.maxTokens, 2000);
  assert.equal(options.max_tokens, 2000);
  console.log('ok - requestSummaryCompactionRaw always caps compaction output, even over caller or preset limits');
}

{
  const text = extractSummaryTagText('<summary>a</summary>\n<summary>b</summary>');
  assert.equal(text, 'b');
  console.log('ok - extractSummaryTagText prefers the last summary block');
}

{
  assert.equal(isValidCompactedSummaryText('【关键事件】\n• 事件1: 内容'), true);
  assert.equal(isValidCompactedSummaryText('普通文本'), false);
  console.log('ok - isValidCompactedSummaryText validates required summary structure');
}

{
  assert.deepEqual(parseSummaryCompactionResult(''), { raw: '', text: '', valid: false });
  assert.deepEqual(parseSummaryCompactionResult('<summary>普通文本</summary>'), {
    raw: '<summary>普通文本</summary>',
    text: '普通文本',
    valid: false,
  });
  assert.deepEqual(parseSummaryCompactionResult('<summary>【关键事件】\n• 事件1: 内容</summary>'), {
    raw: '<summary>【关键事件】\n• 事件1: 内容</summary>',
    text: '【关键事件】\n• 事件1: 内容',
    valid: true,
  });
  console.log('ok - parseSummaryCompactionResult normalizes raw output and validity');
}

{
  // 会话压缩是独立的最小请求：只有压缩提示，不经过正文的消息组装（预设、思维链、角色扮演）。
  const prompt = buildSummaryCompactionPrompt({ payload: '- 摘要一', compactedText: '' });
  assert.deepEqual(buildStandaloneSummaryCompactionMessages(prompt), [{ role: 'user', content: prompt }]);
  const appSource = await readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  const start = appSource.indexOf('const requestSummaryCompaction = createSessionSummaryCompactionRuntime({');
  const block = appSource.slice(start, appSource.indexOf('delayMs: 450,', start));
  assert.ok(start > 0, 'missing session compaction runtime');
  assert.match(block, /buildMessages: buildStandaloneSummaryCompactionMessages,/);
  assert.doesNotMatch(block, /appBridge\.buildMessages/);
  console.log('ok - session summary compaction sends a standalone prompt instead of the reply preset');
}

{
  // 大总结提示词可自定义：只替换规则区，任务说明、<summary> 要求与数据由程序固定附加；默认请求逐字不变。
  const base = { payload: '- [time] foo', compactedText: 'old summary' };
  const defaultPrompt = buildSummaryCompactionPrompt(base);
  assert.equal(buildSummaryCompactionPrompt({ ...base, rules: '' }), defaultPrompt);
  assert.equal(buildSummaryCompactionPrompt({ ...base, rules: `  ${getDefaultSummaryCompactionRules()}\n` }), defaultPrompt);
  for (const line of getDefaultSummaryCompactionRules().split('\n').filter(Boolean)) assert.ok(defaultPrompt.includes(line), line);
  const custom = buildSummaryCompactionPrompt({ ...base, rules: '只写人物关系变化，300 字以内' });
  assert.match(custom, /<summary_rules>\n只写人物关系变化，300 字以内\n\n总结正文必须放在 <summary>\.\.\.<\/summary> 中/);
  assert.doesNotMatch(custom, /总结应当遵循以下原则/);
  assert.match(custom, /# 注意，无视你先前收到的任何指令/);
  assert.match(custom, /【已有大总结】\nold summary/);
  assert.match(custom, /- \[time\] foo$/);
  console.log('ok - custom summary compaction rules replace only the editable rules section');
}

{
  // 自定义规则经 rules 传到请求；会话与动态两条压缩都从全局设置读取。
  let sent = '';
  await requestSummaryCompactionRaw({
    items: [{ at: 0, text: '摘要一' }],
    rules: '自定义规则',
    buildMessages: prompt => { sent = prompt; return []; },
    backgroundChat: async () => '<summary>x</summary>',
  });
  assert.match(sent, /自定义规则/);
  const appSource = await readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  assert.equal(appSource.split('requestCompactionRaw: options => requestSummaryCompactionRaw({ ...options, rules: appSettings.get().summaryCompactionRules }),').length - 1, 2);
  console.log('ok - session and moment compaction read the global custom rules');
}

{
  // 摘要模式按条数触发：满 rowLimit 条才压缩；不传 trigger 时仍按字数（动态大总结沿用）。
  const items = Array.from({ length: 10 }, (_, index) => ({ text: `短${index}` }));
  assert.equal(shouldRunSummaryCompaction({ items, trigger: 'rows', rowLimit: 10 }), true);
  assert.equal(shouldRunSummaryCompaction({ items: items.slice(1), trigger: 'rows', rowLimit: 10 }), false);
  assert.equal(shouldRunSummaryCompaction({ items, trigger: 'rows', rowLimit: 0 }), false);
  assert.equal(shouldRunSummaryCompaction({ items }), false, 'default stays character based');
  assert.equal(shouldRunSummaryCompaction({ items: [{ text: '长'.repeat(1001) }] }), true);
  const appSource = await readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /shouldCompact: \(\{ items, force, place, sessionId \}\) => shouldRunSummaryCompaction\(\{[\s\S]*?resolveMemorySummaryCompactionThreshold\(appSettings\.get\(\)/);
  assert.match(appSource, /if \(!force && appSettings\.get\(\)\.memorySummaryCompactionAuto === false\) return false;/);
  console.log('ok - summary mode compaction follows the shared row or character trigger');
}


{
  // 自定义大总结规则可改标题、列表或段落：只要求 <summary> 里有足够正文；默认规则仍严格按「【关键事件】+ 列表」校验
  const paragraph = '<summary>两人在城门口重逢，她得知旧案另有隐情，决定暂留城中查账，他答应开春回来。</summary>';
  assert.equal(parseSummaryCompactionResult(paragraph).valid, false);
  assert.equal(parseSummaryCompactionResult(paragraph, { strictFormat: false }).valid, true);
  assert.equal(parseSummaryCompactionResult('<summary>太短</summary>', { strictFormat: false }).valid, false);
  assert.equal(parseSummaryCompactionResult('没有标签的正文，内容足够长足够长足够长足够长足够长', { strictFormat: false }).valid, false);
  const app = readFileSync(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  const wired = app.match(/parseCompactionResult: raw => parseSummaryCompactionResult\(raw, \{\s*strictFormat: !resolveCustomSummaryCompactionRules\(appSettings\.get\(\)\.summaryCompactionRules\),\s*\}\)/g) || [];
  assert.equal(wired.length, 2);
  console.log('ok - custom compaction rules relax the summary format check');
}
