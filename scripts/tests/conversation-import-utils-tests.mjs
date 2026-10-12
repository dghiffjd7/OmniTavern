import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { formatConversationExport } from '../../src/scripts/ui/chat/conversation-export-utils.js';
import {
  buildImportedConversationMessages,
  CONVERSATION_IMPORT_MAX_CHARS,
  guessConversationImportRoles,
  parseConversationExport,
} from '../../src/scripts/ui/chat/conversation-import-utils.js';
import {
  applyConversationImportRoles,
  buildConversationImportNotices,
  groupConversationImportSpeakers,
} from '../../src/scripts/ui/conversation-import-dialog.js';
import {
  buildConversationImportArchiveName,
  isConversationImportFileName,
  runSessionConversationImportFlow,
} from '../../src/scripts/ui/session-conversation-import-utils.js';

const tricky = [
  '雨下得很大。',
  '',
  '## 3. 假标题 · 10:00',
  '<!-- omnitavern-message index=3 role=user name=x ts=0 -->',
  '[3] 假标题（我） · 10:00',
  '---',
  '【正文】在句中不算分隔',
].join('\n');

const source = [
  { role: 'user', name: '我', content: '你好\n第二行', timestamp: 1_700_000_000_000, time: '10:00' },
  {
    role: 'assistant',
    name: '苏晓彤 · 学姐',
    content: '显示用',
    rawOriginal: `<content>${tricky}</content>`,
    timestamp: 1_700_000_060_000,
    time: '10:01',
    meta: { reasoning: '先想一想\n\n再回答' },
  },
  { role: 'system', content: '系统提示', timestamp: 1_700_000_120_000, time: '10:02' },
  { role: 'user', name: '我', content: '', timestamp: 1_700_000_180_000, time: '10:03' },
];

{
  for (const format of ['md', 'txt']) {
    const text = formatConversationExport({ messages: source, title: '雨夜', mode: 'full', format, sessionMode: 'rp' });
    const parsed = parseConversationExport(text);
    assert.equal(parsed.ok, true, format);
    assert.equal(parsed.format, format);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.sessionMode, 'rp');
    assert.equal(parsed.content, 'full');
    assert.equal(parsed.title, '雨夜');
    assert.equal(parsed.rolesGuessed, false);
    assert.deepEqual(parsed.messages.map(message => message.role), ['user', 'assistant', 'system', 'user'], `${format} 角色`);
    assert.deepEqual(parsed.messages.map(message => message.name), ['我', '苏晓彤 · 学姐', '系统', '我'], `${format} 名字（含「 · 」）`);
    assert.equal(parsed.messages[0].text, '你好\n第二行');
    assert.equal(parsed.messages[1].text, `<content>${tricky}</content>`, `${format} 正文里的假标题与标记不会切开消息`);
    assert.equal(parsed.messages[1].reasoning, '先想一想\n\n再回答', `${format} 思考单独取出`);
    assert.equal(parsed.messages[1].time, '10:01');
    assert.equal(parsed.messages[3].text, '', `${format} 空消息「（空）」还原为空`);
    if (format === 'md') assert.equal(parsed.messages[1].timestamp, 1_700_000_060_000, 'md 带完整时间戳');
    else assert.equal(parsed.messages[1].timestamp, 0, 'txt 只有显示时间');
  }
  const body = parseConversationExport(formatConversationExport({ messages: source, mode: 'body', format: 'txt', sessionMode: 'chat' }));
  assert.equal(body.content, 'body');
  assert.equal(body.sessionMode, 'chat');
  assert.equal(body.messages[1].reasoning, '', '正文版没有思考');
  const crlf = formatConversationExport({ messages: source, mode: 'full', format: 'txt', sessionMode: 'rp' }).replace(/\n/g, '\r\n');
  assert.equal(parseConversationExport(`﻿${crlf}`).messages.length, 4, 'BOM 与 Windows 换行也能读');
  console.log('ok - v1 md/txt exports round-trip through the import parser');
}

{
  const legacyTxt = [
    '雨夜',
    '来源：当前聊天',
    '导出模式：正文',
    '导出时间：2026/9/1 10:00:00',
    '消息数：3',
    '='.repeat(32),
    '',
    '[1] 苏晓彤 · 10:00',
    '',
    '很长很长的开场白，很长很长的开场白，很长很长的开场白。',
    '',
    '-'.repeat(32),
    '',
    '[2] 阿兰 · 10:01',
    '',
    '短句',
    '[3] 不是标题',
    '',
    '-'.repeat(32),
    '',
    '[3] 苏晓彤 · 10:02',
    '',
    '又是很长很长的回复，又是很长很长的回复，又是很长很长的回复。',
    '',
    '-'.repeat(32),
  ].join('\n');
  const parsed = parseConversationExport(legacyTxt);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.version, 0);
  assert.equal(parsed.content, 'body');
  assert.equal(parsed.sessionMode, '', '旧版不知道模式');
  assert.equal(parsed.rolesGuessed, true);
  assert.deepEqual(parsed.messages.map(message => [message.name, message.role]), [
    ['苏晓彤', 'assistant'],
    ['阿兰', 'user'],
    ['苏晓彤', 'assistant'],
  ], '篇幅短的名字当作「我」');
  assert.equal(parsed.messages[1].text, '短句\n[3] 不是标题', '正文里的编号行前面没有分隔线，不会被当成标题');

  const legacyMd = [
    '# 雨夜',
    '',
    '- 导出模式：完整',
    '',
    '---',
    '',
    '## 1. 用户 · 10:00',
    '',
    '你好',
    '',
    '## 2. AI · 10:01',
    '',
    '回答',
    '## 3. 紧贴上一行的不算',
  ].join('\n');
  const md = parseConversationExport(legacyMd);
  assert.equal(md.format, 'md');
  assert.equal(md.content, 'full');
  assert.deepEqual(md.messages.map(message => [message.name, message.role, message.text]), [
    ['用户', 'user', '你好'],
    ['AI', 'assistant', '回答\n## 3. 紧贴上一行的不算'],
  ]);
  assert.deepEqual(guessConversationImportRoles([{ name: '系统', role: '', text: 'x' }, { name: '独白', role: '', text: 'y' }]).map(m => m.role),
    ['system', 'assistant'], '只剩一个名字时当作 AI');
  console.log('ok - legacy exports split on numbered headings and guess roles by name');
}

{
  assert.deepEqual(parseConversationExport(''), { ok: false, error: 'empty' });
  assert.deepEqual(parseConversationExport('随便一段文字\n没有标题'), { ok: false, error: 'unrecognized' });
  assert.deepEqual(parseConversationExport('x'.repeat(CONVERSATION_IMPORT_MAX_CHARS + 1)), { ok: false, error: 'too_large' });
  assert.deepEqual(parseConversationExport('【OmniTavern 导出 v1 · 聊天 · 完整】\n标题\n' + '='.repeat(32)), { ok: false, error: 'no_messages' });
  const many = Array.from({ length: 3000 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', name: i % 2 ? 'AI' : '我', content: `第${i}条\n${'字'.repeat(200)}` }));
  const started = Date.now();
  assert.equal(parseConversationExport(formatConversationExport({ messages: many, mode: 'full', format: 'md', sessionMode: 'chat' })).messages.length, 3000);
  assert.ok(Date.now() - started < 3000, '3000 条的大文件也能很快解析');
  console.log('ok - parser rejects empty, foreign and oversized files and handles large exports');
}

{
  const parsed = [
    { role: 'user', name: '我', text: '你好', reasoning: '', timestamp: 0, time: '10:00' },
    { role: 'assistant', name: '苏晓彤', text: '正文<UpdateVariable>_.set("好感", 1);</UpdateVariable><tableEdit>insertRow(0, {})</tableEdit>', reasoning: '思考', timestamp: 0, time: '10:01' },
    { role: 'system', name: '系统', text: '提示', reasoning: '', timestamp: 5, time: '' },
  ];
  const rp = buildImportedConversationMessages(parsed, { sessionMode: 'rp', now: 10_000 });
  assert.deepEqual(rp.map(message => message.timestamp), [8_000, 9_000, 5], '缺时间的按顺序补，最后一条为导入时刻');
  assert.deepEqual(rp[0], { role: 'user', type: 'text', timestamp: 8_000, time: '10:00', name: '我', content: '你好', raw: '你好' });
  assert.equal(rp[1].rawOriginal, parsed[1].text, '原文完整保留');
  assert.equal(rp[1].content, '正文', '显示用正文去掉变量与表格块，导入后不会再执行');
  assert.equal(rp[1].rawSource, '正文');
  assert.deepEqual(rp[1].meta, { renderRich: true, reasoning: '思考' });
  assert.equal(rp[2].name, undefined, '系统消息不带名字');
  const chat = buildImportedConversationMessages(parsed, { sessionMode: 'chat', now: 10_000 });
  assert.deepEqual(chat[1].meta, { reasoning: '思考' }, '聊天模式不开富文本渲染');
  assert.equal(chat[1].rawSource, undefined);
  console.log('ok - imported messages keep the raw original and drop executable blocks from the display text');
}

{
  const messages = [
    { role: 'user', name: '阿兰', text: 'a' },
    { role: 'assistant', name: '苏晓彤', text: 'b' },
    { role: 'user', name: '阿兰', text: 'c' },
    { role: 'system', name: '系统', text: 'd' },
  ];
  const speakers = groupConversationImportSpeakers(messages);
  assert.deepEqual(speakers.map(speaker => [speaker.name, speaker.role, speaker.count]), [['阿兰', 'user', 2], ['苏晓彤', 'assistant', 1], ['系统', 'system', 1]]);
  const roles = new Map(speakers.map(speaker => [speaker.key, speaker.role]));
  roles.set(speakers[0].key, 'assistant');
  assert.deepEqual(applyConversationImportRoles(messages, roles).map(message => message.role), ['assistant', 'assistant', 'assistant', 'system'], '同名消息一起切换');
  assert.equal(messages[0].role, 'user', '不改动原数组');

  assert.deepEqual(buildConversationImportNotices({ parsed: { sessionMode: 'rp', content: 'full' }, sessionMode: 'rp' }), []);
  const notices = buildConversationImportNotices({ parsed: { sessionMode: 'chat', content: 'body', rolesGuessed: true }, sessionMode: 'rp' });
  assert.equal(notices.length, 3);
  assert.match(notices[0], /「聊天」.*「创意写作」/, '模式不符时提醒');
  assert.match(notices[1], /格式与思考已在导出时去掉/);
  assert.match(notices[2], /按名字推测/);
  console.log('ok - import preview groups speakers, toggles roles per speaker and explains mismatches');
}

{
  assert.equal(isConversationImportFileName('a.MD'), true);
  assert.equal(isConversationImportFileName('a.txt'), true);
  assert.equal(isConversationImportFileName('a.json'), false);
  assert.equal(buildConversationImportArchiveName({ title: '雨夜', fileName: 'x.md' }), '导入：雨夜');
  assert.equal(buildConversationImportArchiveName({ title: '当前聊天', fileName: '家-full-20261009132917.txt' }), '导入：家');
  assert.equal(buildConversationImportArchiveName({ title: '当前群聊', fileName: '.md' }), '导入：当前群聊');

  const text = formatConversationExport({ messages: source, title: '雨夜', mode: 'full', format: 'txt', sessionMode: 'chat' });
  const file = { name: '雨夜-full-20261009132917.txt', size: text.length, text: async () => text };
  const calls = { imported: [], loaded: [], errors: [], dialog: null };
  const chatStore = {
    importMessagesAsArchive: async (sid, payload) => {
      calls.imported.push({ sid, payload });
      return 'arc-1';
    },
  };
  const archiveId = await runSessionConversationImportFlow({
    file,
    chatStore,
    sessionId: 'rp:card',
    resolveMemoryTemplateId: async () => 'tpl',
    openImportDialog: async (options) => {
      calls.dialog = options;
      const id = await options.onImport({ name: '我的存档', messages: options.parsed.messages });
      return { archiveId: id, load: true };
    },
    onImported: payload => calls.onImported = payload,
    loadArchive: async id => calls.loaded.push(id),
    now: () => 50_000,
    toastError: text => calls.errors.push(text),
  });
  assert.equal(archiveId, 'arc-1');
  assert.equal(calls.dialog.sessionMode, 'rp', '对话框拿到当前会话的模式，用来提醒不符');
  assert.equal(calls.dialog.parsed.sessionMode, 'chat');
  assert.equal(calls.dialog.defaultName, '导入：雨夜');
  assert.equal(calls.imported[0].sid, 'rp:card');
  assert.equal(calls.imported[0].payload.name, '我的存档');
  assert.deepEqual(calls.imported[0].payload.memoryTableSnapshot, { templateId: 'tpl', rows: [] }, '记忆表格从空开始');
  assert.equal(calls.imported[0].payload.messages[1].meta.renderRich, true, '按当前会话（创意写作）整理消息');
  assert.deepEqual(calls.onImported, { sessionId: 'rp:card', archiveId: 'arc-1' });
  assert.deepEqual(calls.loaded, ['arc-1'], '点「立即加载」后加载新存档');
  assert.deepEqual(calls.errors, []);

  let opened = false;
  const openImportDialog = async () => { opened = true; return {}; };
  const warnings = [];
  assert.equal(await runSessionConversationImportFlow({ file: { name: 'a.json' }, chatStore, sessionId: 'rp:card', openImportDialog, toastWarning: t => warnings.push(t) }), '');
  assert.deepEqual(warnings, ['只支持 md／txt 文件']);
  const errors = [];
  assert.equal(await runSessionConversationImportFlow({ file: { name: 'a.txt', size: 3, text: async () => '随便' }, chatStore, sessionId: 'rp:card', openImportDialog, toastError: t => errors.push(t) }), '');
  assert.match(errors[0], /无法识别/);
  assert.equal(opened, false, '解析失败时不打开对话框');
  console.log('ok - import flow parses the file, previews it and stores an archive with an empty memory snapshot');
}

{
  const css = await readFile(new URL('../../src/assets/css/conversation-transfer-dialog.css', import.meta.url), 'utf8');
  const settingsCss = await readFile(new URL('../../src/assets/css/settings-panel-redesign.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, '只用主题变量');
  assert.doesNotMatch(settingsCss.slice(settingsCss.indexOf('导入聊天记录：拖放区域')), /#[0-9a-fA-F]{3,8}\b/);
  for (const panel of ['contact-settings-panel.js', 'group-chat-panels.js']) {
    const sourceText = await readFile(new URL(`../../src/scripts/ui/${panel}`, import.meta.url), 'utf8');
    assert.match(sourceText, /id="(contact|group)-archives-import"/, `${panel} 存档区有「导入」`);
    assert.match(sourceText, /bindConversationImportDropZone\(\{\s*zoneEl: this\.panel\.querySelector\('\[data-settings-section=archives\]'\)/, `${panel} 可拖入文件`);
    assert.match(sourceText, /loadArchive: archiveId => this\.ensureArchiveRuntime\(\)\.loadArchive\(archiveId\)/);
  }
  console.log('ok - both settings panels expose import, drag-and-drop and load-now');
}

{
  const { buildConversationImportFootnote } = await import('../../src/scripts/ui/conversation-import-dialog.js');
  const { describeConversationImportState } = await import('../../src/scripts/ui/session-conversation-import-utils.js');
  const { loadConversationExportState } = await import('../../src/scripts/ui/session-conversation-export-utils.js');
  const state = {
    memoryTable: { templateId: 'tpl', rows: [{ id: 'r1', table_id: 'people', row_data: { name: '苏晓彤 -->' }, priority: 2 }] },
    summaries: ['第一天', { at: 5, text: '第二天' }],
    compactedSummary: { at: 9, text: '大总结' },
    variables: { 好感: 3 },
  };
  const messages = [{ role: 'user', name: '我', content: '你好' }, { role: 'assistant', name: 'AI', content: '最后一条' }];
  for (const format of ['md', 'txt']) {
    const text = formatConversationExport({ messages, mode: 'full', format, sessionMode: 'rp', state });
    const parsed = parseConversationExport(text);
    assert.equal(parsed.messages[1].text, '最后一条', `${format} 附加数据不会并进最后一条消息`);
    assert.deepEqual(parsed.state.memoryTable, {
      templateId: 'tpl',
      rows: [{ table_id: 'people', row_data: { name: '苏晓彤 -->' }, is_active: true, is_pinned: false, priority: 2, sort_order: 0 }],
    }, `${format} 表格行原样带回（不带 id）`);
    assert.deepEqual(parsed.state.summaries, [{ at: 0, text: '第一天' }, { at: 5, text: '第二天' }]);
    assert.deepEqual(parsed.state.compactedSummary, { at: 9, text: '大总结' });
    assert.deepEqual(parsed.state.variables, { 好感: 3 });
    if (format === 'md') assert.doesNotMatch(text, /苏晓彤 -->/, 'md 附加数据经编码，不会提前结束注释');
    else assert.match(text, /【附加数据 v1 · /, 'txt 附加数据在文末看得到');
  }
  assert.doesNotMatch(formatConversationExport({ messages, mode: 'body', format: 'txt', state }), /附加数据/, '正文版不带附加数据');
  assert.doesNotMatch(formatConversationExport({ messages, mode: 'full', format: 'md', state: { memoryTable: { templateId: 'tpl', rows: [] }, variables: {} } }), /omnitavern-state/, '都没有内容时不写');
  const broken = formatConversationExport({ messages, mode: 'full', format: 'txt', state }).replace(/\{"memoryTable".*$/m, '{坏掉的');
  const brokenParsed = parseConversationExport(broken);
  assert.equal(brokenParsed.state, null, '附加数据坏掉时当作没有');
  assert.equal(brokenParsed.messages[1].text, '最后一条', '坏掉的附加数据也不会并进消息');
  assert.equal(parseConversationExport(formatConversationExport({ messages, mode: 'full', format: 'md' })).state, null);

  const info = describeConversationImportState({ state: parseConversationExport(formatConversationExport({ messages, mode: 'full', format: 'md', state })).state, templateId: 'tpl', tableMode: true });
  assert.deepEqual(info, {
    memory: { count: 1, usable: true, reason: '' },
    summaries: { count: 3, usable: true, reason: '' },
    variables: { count: 1, usable: true, reason: '' },
  });
  const otherTemplate = describeConversationImportState({ state, templateId: 'other', tableMode: true });
  assert.deepEqual([otherTemplate.memory.usable, otherTemplate.memory.reason], [false, 'template'], '模板不同时表格不能用');
  const summaryMode = describeConversationImportState({ state, templateId: 'tpl', tableMode: false });
  assert.deepEqual([summaryMode.memory.reason, summaryMode.variables.reason, summaryMode.summaries.usable], ['mode', 'mode', true], '非表格模式只能带摘要');
  assert.deepEqual(describeConversationImportState({ state: null, templateId: 'tpl', tableMode: true }).memory, { count: 0, usable: false, reason: '' });
  assert.equal(buildConversationImportFootnote(info, { memory: true, summaries: true, variables: true }), '记忆表格用文件里的 · 加载时还原变量');
  assert.equal(buildConversationImportFootnote(info, { memory: false, variables: false }), '记忆表格从空开始 · 变量保持不变');

  const calls = { imported: null, bound: null };
  const flowText = formatConversationExport({ messages, title: '雨夜', mode: 'full', format: 'md', sessionMode: 'rp', state });
  const run = include => runSessionConversationImportFlow({
    file: { name: '雨夜.md', size: flowText.length, text: async () => flowText },
    chatStore: { importMessagesAsArchive: async (sid, payload) => { calls.imported = payload; return 'arc-9'; } },
    sessionId: 'rp:card',
    resolveMemoryTemplateId: async () => 'tpl',
    getMemoryStorageMode: () => 'table',
    bindImportedState: async (sid, aid, payload) => { calls.bound = { sid, aid, payload }; },
    openImportDialog: async (options) => {
      calls.dialogInfo = options.stateInfo;
      return { archiveId: await options.onImport({ name: 'x', messages: options.parsed.messages, include }) };
    },
  });
  await run({ memory: true, summaries: true, variables: true });
  assert.equal(calls.dialogInfo.memory.usable, true, '对话框拿到附加数据可用情况');
  assert.equal(calls.imported.memoryTableSnapshot.rows.length, 1, '新存档带文件里的表格');
  assert.equal(calls.imported.summaries.length, 2);
  assert.deepEqual(calls.imported.compactedSummary, { at: 9, text: '大总结' });
  assert.deepEqual(calls.bound, { sid: 'rp:card', aid: 'arc-9', payload: { memoryTable: { templateId: 'tpl', rows: calls.imported.memoryTableSnapshot.rows }, variables: { 好感: 3 } } },
    '表格与变量绑定到新存档的存档指针');
  calls.bound = null;
  await run({ memory: false, summaries: false, variables: true });
  assert.deepEqual(calls.imported.memoryTableSnapshot, { templateId: 'tpl', rows: [] }, '取消表格时从空开始');
  assert.deepEqual(calls.imported.summaries, []);
  assert.equal(calls.imported.compactedSummary, null);
  assert.deepEqual(calls.bound.payload, { memoryTable: null, variables: { 好感: 3 } });
  calls.bound = null;
  await run({ memory: false, summaries: true, variables: false });
  assert.equal(calls.bound, null, '表格与变量都不要时不写存档指针');

  const chatStore = {
    getCurrentArchiveId: () => 'live',
    getSummaries: () => [{ at: 1, text: '当前摘要' }],
    getCompactedSummary: () => ({ at: 2, text: '当前大总结', raw: 'x' }),
    listVariables: () => ({ 当前: 1 }),
  };
  const live = await loadConversationExportState({ chatStore, sessionId: 'rp:card', current: true, buildMemoryTableSnapshot: async () => ({ templateId: 'tpl', rows: [] }) });
  assert.deepEqual(live.variables, { 当前: 1 }, '当前聊天取实际状态');
  assert.equal(live.summaries[0].text, '当前摘要');
  const loadedArchive = await loadConversationExportState({ chatStore, sessionId: 'rp:card', archive: { id: 'live' }, buildMemoryTableSnapshot: async () => 'live-table' });
  assert.equal(loadedArchive.memoryTable, 'live-table', '当前已加载的存档也取实际状态');
  const other = await loadConversationExportState({
    chatStore,
    sessionId: 'rp:card',
    archive: { id: 'old', summaries: [{ at: 3, text: '旧摘要' }], memoryTableSnapshot: { templateId: 'tpl', rows: ['fallback'] } },
    readArchiveState: async () => ({ memoryTable: null, variables: { 旧: 2 } }),
  });
  assert.deepEqual(other, { memoryTable: { templateId: 'tpl', rows: ['fallback'] }, summaries: [{ at: 3, text: '旧摘要' }], compactedSummary: null, variables: { 旧: 2 } },
    '其他存档取存档指针的快照，没有记忆快照时退回存档里存的表格');
  console.log('ok - full exports carry memory tables, summaries and variables, and import binds the checked ones to the new archive');
}
