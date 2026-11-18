import assert from 'node:assert/strict';
import { createUtilityAgentRuntime } from '../../src/scripts/agent/utility-agent-runtime.js';

import {
  applyStickerKeywordUpdates,
  createStewardMessageTranslation,
  createStewardStickerNaming,
  createStewardToolbox,
  isStewardToolId,
  stewardCustomToolId,
} from '../../src/scripts/ui/chat/steward-app-runtime.js';
import { buildMessageStewardNoteElement, buildMessageTranslationSignature, getMessageStewardNote, getMessageTranslation } from '../../src/scripts/ui/chat/message-translation-ui-utils.js';
import { TOOL_ACTION_GROUPS, stewardToolAction } from '../../src/scripts/ui/tools/user-tool-actions.js';
import { USER_TOOL_SOURCES } from '../../src/scripts/storage/user-tool-store.js';

{
  // 模型仍在运行时切聊天室/存档或继续编辑，真实运行时应取消写入；未变化时仍正常完成。
  for (const change of ['room', 'archive', 'draft', 'none']) {
    let room = 'a', archive = 'first', release;
    const drafts = { a: 'draft A', b: 'draft B' };
    const config = { enabled: true, modelMode: 'profile', modelProfileId: 'test', tasks: {},
      customTasks: [{ id: 'ct_input01', name: '润色', input: 'input', output: 'input', prompt: 'polish', enabled: true }] };
    const getContext = () => ({ place: 'chat', scopeId: 'card', sessionId: room, archiveId: archive });
    let started;
    const requested = new Promise(resolve => { started = resolve; });
    const runtime = createUtilityAgentRuntime({
      chatStore: { state: {}, subscribeArchives: () => () => {} }, configStore: { read: () => ({ config, revision: 1 }) }, getContext,
      captureModel: async () => ({ model: 'test' }),
      request: () => new Promise(resolve => { release = resolve; started(); }),
    });
    const toolbox = createStewardToolbox({
      runTask: options => runtime.runTask(options), getContext, readConfig: () => config,
      getSessionId: () => room, getInputText: () => drafts[room],
      writeInput: text => { drafts[room] = text; },
    });
    const pending = toolbox.run(stewardCustomToolId('ct_input01'));
    await requested;
    if (change === 'room') room = 'b';
    if (change === 'archive') archive = 'second';
    if (change === 'draft') drafts.a = 'new user draft';
    release('polished A');
    const outcome = await pending;
    assert.equal(drafts.b, 'draft B', '另一聊天室的草稿必须保留');
    assert.equal(drafts.a, change === 'none' ? 'polished A' : change === 'draft' ? 'new user draft' : 'draft A', change);
    assert.equal(outcome.status === 'succeeded', change === 'none', change);
    runtime.dispose();
  }
  console.log('ok - steward input tasks preserve switched targets and newer drafts');
}

{
  // 翻译：按当前显示的分支取原文与指纹；成功写回，失败与没文字都只提示
  const writes = [];
  const warnings = [];
  const requests = [];
  const stored = { id: 'm1', role: 'assistant', content: 'old branch', meta: { swipes: [{ content: 'old branch' }, { content: 'Good night.' }], activeSwipe: 1 } };
  const translate = createStewardMessageTranslation({
    runTask: async (options) => { requests.push(options); return { status: 'succeeded', result: '晚安。' }; },
    getLocale: () => 'zh-CN',
    readTaskSettings: () => ({ targetLanguage: '' }),
    resolveShown: message => (message.meta?.swipes ? { ...message, content: message.meta.swipes[message.meta.activeSwipe].content } : message),
    writeTranslation: (id, sessionId, translation) => { writes.push({ id, sessionId, translation }); return true; },
    warn: message => warnings.push(message),
  });
  assert.equal(await translate(stored, 'room'), true);
  assert.equal(requests[0].taskId, 'translate_message');
  assert.equal(requests[0].targetKey, 'room:m1');
  assert.equal(requests[0].payload.messages[1].content, 'Good night.', 'the shown branch is what gets translated');
  const translation = writes[0].translation;
  assert.equal(translation.languageLabel, '简体中文');
  assert.ok(getMessageTranslation({ content: 'Good night.', meta: { stewardTranslation: translation } }), 'fingerprint matches the shown branch');
  assert.equal(getMessageTranslation({ content: 'old branch', meta: { stewardTranslation: translation } }), null);

  assert.equal(await translate({ id: 'm2', content: '   ' }, 'room'), false);
  assert.match(warnings.at(-1), /没有可翻译的文字/);
  const failing = createStewardMessageTranslation({
    runTask: async () => ({ status: 'failed', reason: '请求超时' }),
    warn: message => warnings.push(message),
  });
  assert.equal(await failing({ id: 'm3', content: 'Hi' }, 'room'), false);
  assert.equal(warnings.at(-1), '请求超时');
  const throwing = createStewardMessageTranslation({
    runTask: async () => { throw new Error('请先在 Agent Center 开启小管家与这个任务'); },
    warn: message => warnings.push(message),
  });
  assert.equal(await throwing({ id: 'm4', content: 'Hi' }, 'room'), false);
  assert.match(warnings.at(-1), /开启小管家/);
  console.log('ok - steward translation uses the shown branch and reports failures once');
}

{
  const pack = { id: 'p', stickers: [{ id: 'a', keyword: '' }, { id: 'b', keyword: '手动' }] };
  const result = applyStickerKeywordUpdates(pack, new Map([['a', '开心'], ['b', '晚安']]), new Map([['a', ''], ['b', '']]));
  assert.deepEqual(result.changed, ['a'], 'a sticker edited by hand in the meantime keeps its keyword');
  assert.deepEqual(result.pack.stickers.map(s => s.keyword), ['开心', '手动']);
  console.log('ok - sticker keyword updates only replace values that are still the expected ones');
}

{
  // 贴图起名：8 张分两批；跨批去重；第一批写完后手动改掉一张，还原时保留手动值；读图失败的跳过
  let pack = {
    id: 'p',
    stickers: Array.from({ length: 9 }, (_, index) => ({ id: `s${index}`, keyword: index === 8 ? '开心' : '', dataUrl: `data:${index}` })),
  };
  const saves = [];
  const undos = [];
  const requests = [];
  const replies = [['开心', '大哭', '生气', '晚安', '委屈', '开心'], ['大哭']];
  const name = createStewardStickerNaming({
    runTask: async (options) => {
      requests.push(options);
      const keywords = replies[requests.length - 1];
      return { status: 'succeeded', result: options.parse(JSON.stringify({ keywords })) };
    },
    getLocale: () => 'zh-CN',
    getPack: () => pack,
    savePack: (id, next) => { pack = next; saves.push(next.stickers.map(s => s.keyword)); if (saves.length === 1) pack = applyStickerKeywordUpdates(pack, new Map([['s1', '我改的']]), new Map([['s1', '大哭']])).pack; },
    listOtherKeywords: excludeIds => pack.stickers.filter(s => !excludeIds.has(s.id)).map(s => s.keyword).filter(Boolean),
    loadImage: async sticker => (sticker.id === 's7' ? '' : `url:${sticker.id}`),
    showUndo: options => undos.push(options),
  });
  const count = await name('p');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].payload.messages[1].content.filter(part => part.type === 'image_url').length, 6);
  assert.equal(requests[1].payload.messages[1].content.filter(part => part.type === 'image_url').length, 1, 's7 failed to load and is skipped');
  assert.match(requests[0].payload.messages[0].content, /existing keywords: 开心/, 'other packs\' keywords are avoided');
  assert.equal(count, 7);
  const keywords = pack.stickers.map(s => s.keyword);
  assert.deepEqual(keywords.slice(0, 6), ['开心2', '我改的', '生气', '晚安', '委屈', '开心3'], 'duplicates get a number; the manual edit stays');
  assert.equal(keywords[6], '大哭2', 'the second batch avoids keywords written by the first');
  assert.equal(keywords[7], '', 'the sticker whose image failed stays unnamed');
  assert.match(undos[0].message, /7 张/);
  undos[0].onAction();
  assert.deepEqual(pack.stickers.map(s => s.keyword), ['', '我改的', '', '', '', '', '', '', '开心'], 'restore only touches values this run wrote');
  console.log('ok - sticker naming batches, de-duplicates, keeps manual edits and restores');
}

{
  // 只补刚加的几张；模型检查不过就停下并提示一次，不写入
  const pack = { id: 'p', stickers: [{ id: 'a', keyword: '' }, { id: 'b', keyword: '' }] };
  const warnings = [];
  const seen = [];
  const name = createStewardStickerNaming({
    runTask: async (options) => { seen.push(options.payload.messages[1].content.filter(part => part.type === 'image_url').length); return { status: 'failed', reason: '小管家的模型不能看图' }; },
    getPack: () => pack,
    savePack: () => assert.fail('nothing is written'),
    loadImage: async sticker => `url:${sticker.id}`,
    warn: message => warnings.push(message),
    showUndo: () => assert.fail('no undo without writes'),
  });
  assert.equal(await name('p', { stickerIds: ['b'] }), 0);
  assert.deepEqual(seen, [1], 'only the newly added sticker is sent');
  assert.deepEqual(warnings, ['小管家的模型不能看图']);
  assert.equal(await name('missing'), 0);
  console.log('ok - sticker naming can be limited to new stickers and stops on a failed model check');
}

{
  // 工具箱入口：翻译（选中文字弹窗、整条写气泡下方）与自定义任务（各种输入与结果去向）
  const messages = [
    { id: 'u1', role: 'user', name: '我', content: '今天好累' },
    { id: 'a1', role: 'assistant', name: '小雪', content: 'Get some rest, okay?' },
  ];
  const customTasks = [
    { id: 'ct_popup01', name: '总结', input: 'recent', recentCount: 2, output: 'popup', prompt: '用一句话总结', enabled: true },
    { id: 'ct_note001', name: '语气', input: 'selection', output: 'bubble', prompt: '分析语气', enabled: true },
    { id: 'ct_input01', name: '润色', input: 'input', output: 'input', prompt: '润色草稿', enabled: true },
    { id: 'ct_reply01', name: '回复', input: 'message', output: 'input', prompt: '写一句回复', enabled: true },
    { id: 'ct_off0001', name: '关着', input: 'message', output: 'popup', prompt: 'x', enabled: false },
  ];
  const ready = new Set(['translate_message', 'custom_tasks']);
  const config = { enabled: true, modelMode: 'profile', modelProfileId: 'm', tasks: {}, customTasks };
  const calls = [];
  const shown = [];
  const notes = [];
  const inputs = [];
  const translated = [];
  let draft = '帮我回她';
  const toolbox = createStewardToolbox({
    runTask: async (options) => { calls.push(options); return { status: 'succeeded', result: `结果${calls.length}` }; },
    getLocale: () => 'zh-CN',
    readConfig: () => config,
    isTaskReady: taskId => ready.has(taskId) && (taskId !== 'custom_tasks' || config.tasks.custom_tasks?.enabled !== false),
    getSessionId: () => 'room',
    getMessages: () => messages,
    findMessage: id => messages.find(message => message.id === id) || null,
    findLastReply: () => messages[1],
    speakerOf: message => message.name,
    getInputText: () => draft,
    translateMessage: async (message) => { translated.push(message.id); return true; },
    writeNote: (id, sessionId, note) => { notes.push({ id, note }); return true; },
    writeInput: (text, options) => inputs.push({ text, mode: options.mode }),
    showResult: result => shown.push(result),
  });
  assert.deepEqual(toolbox.list().map(item => item.id), ['steward:translate', 'steward:custom:ct_popup01', 'steward:custom:ct_note001', 'steward:custom:ct_input01', 'steward:custom:ct_reply01']);
  assert.ok(isStewardToolId('steward:translate'));
  assert.equal(isStewardToolId('tool_abcd'), false);

  assert.equal((await toolbox.run('steward:translate', { selection: 'rest' })).status, 'succeeded');
  assert.equal(calls.at(-1).payload.messages[1].content, 'rest');
  assert.equal(shown.at(-1).title, '翻译 · 简体中文');
  assert.equal((await toolbox.run('steward:translate', {})).status, 'succeeded');
  assert.deepEqual(translated, ['a1'], 'without a selection the whole last reply is translated under its bubble');

  await toolbox.run(stewardCustomToolId('ct_popup01'));
  assert.equal(calls.at(-1).taskId, 'custom_tasks');
  assert.equal(calls.at(-1).payload.messages[1].content, '我: 今天好累\n小雪: Get some rest, okay?');
  assert.deepEqual(shown.at(-1), { title: '总结', text: `结果${calls.length}` });

  await toolbox.run(stewardCustomToolId('ct_note001'), { messageId: 'u1' });
  assert.equal(calls.at(-1).payload.messages[1].content, '今天好累', 'no selection: the target message is used');
  assert.equal(notes.at(-1).id, 'u1');
  assert.equal(notes.at(-1).note.title, '语气');
  assert.ok(getMessageStewardNote({ ...messages[0], meta: { stewardNote: notes.at(-1).note } }));
  await toolbox.run(stewardCustomToolId('ct_note001'), { messageId: 'a1', selection: 'okay' });
  assert.equal(calls.at(-1).payload.messages[1].content, 'okay');

  await toolbox.run(stewardCustomToolId('ct_input01'));
  assert.equal(calls.at(-1).payload.messages[1].content, '帮我回她');
  assert.deepEqual(inputs.at(-1), { text: `结果${calls.length}`, mode: 'replace' }, 'a draft task replaces the draft');
  await toolbox.run(stewardCustomToolId('ct_reply01'));
  assert.equal(inputs.at(-1).mode, 'insert', 'other inputs insert at the cursor');

  draft = '  ';
  assert.deepEqual(await toolbox.run(stewardCustomToolId('ct_input01')), { status: 'unavailable', message: '输入框是空的' });
  assert.equal((await toolbox.run(stewardCustomToolId('ct_off0001'))).status, 'unavailable');
  assert.equal((await toolbox.run('steward:custom:missing')).status, 'unavailable');
  config.tasks = { custom_tasks: { enabled: false } };
  assert.deepEqual(toolbox.list().map(item => item.id), ['steward:translate'], 'custom tasks hide when their switch is off');
  config.tasks = {};

  const failing = createStewardToolbox({ runTask: async () => ({ status: 'failed', reason: '请求超时' }), readConfig: () => config, isTaskReady: () => true,
    getSessionId: () => 'room', getMessages: () => messages, findLastReply: () => messages[1] });
  assert.deepEqual(await failing.run(stewardCustomToolId('ct_popup01')), { status: 'failed', message: '请求超时' });
  const outside = createStewardToolbox({ readConfig: () => config, isTaskReady: () => true, getSessionId: () => '' });
  assert.equal((await outside.run('steward:translate', { selection: 'x' })).message, '请先进入聊天');

  // 已经做成工具的任务（与翻译）不在工具箱重复列出，但仍可执行（做成的工具走同一个入口）
  const wrapped = createStewardToolbox({ runTask: async () => ({ status: 'succeeded', result: 'ok' }), readConfig: () => config, isTaskReady: () => true,
    getSessionId: () => 'room', getMessages: () => messages, findLastReply: () => messages[1], showResult: () => {},
    listToolActions: () => [{ source: 'steward', id: 'ct_popup01' }, { source: 'builtin', id: 'text.translate' }, { source: 'builtin', id: 'chat.regenerate' }] });
  assert.deepEqual(wrapped.list().map(item => item.id), ['steward:custom:ct_note001', 'steward:custom:ct_input01', 'steward:custom:ct_reply01']);
  assert.equal((await wrapped.run(stewardCustomToolId('ct_popup01'))).status, 'succeeded');
  console.log('ok - steward toolbox runs translate and custom tasks with every input and output');
}

{
  // 自定义任务的附注：气泡下方一行，标题是任务名；与译文一起进重画签名；可做成工具
  const createDocument = () => ({ createElement: tag => ({ tagName: tag, children: [], dataset: {}, style: {}, appendChild(child) { this.children.push(child); return child; }, addEventListener(type, fn) { this[`on${type}`] = fn; } }) });
  const message = { id: 'm', content: 'hello', meta: { stewardNote: { title: '语气', text: '很友善', sourceKey: '' } } };
  message.meta.stewardNote.sourceKey = (await import('../../src/scripts/ui/chat/message-translation-ui-utils.js')).messageTranslationKey(message);
  const removed = [];
  const element = buildMessageStewardNoteElement({ documentLike: createDocument(), message, onRemove: value => removed.push(value.id) });
  assert.equal(element.className, 'chat-message-steward-note');
  assert.equal(element.children[0].children[0].textContent, '小管家 · 语气');
  assert.equal(element.children[1].textContent, '很友善');
  element.children[0].children[1].onclick({ preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(removed, ['m']);
  assert.notEqual(buildMessageTranslationSignature(message), '', 'notes re-render the bubble like translations');
  assert.equal(getMessageTranslation(message), null);
  const action = stewardToolAction({ id: 'ct_abcd1234', name: '语气' });
  assert.deepEqual([action.source, action.id, action.group, action.title, action.target], ['steward', 'ct_abcd1234', 'steward', '语气', 'any']);
  assert.ok(TOOL_ACTION_GROUPS.some(group => group.id === 'steward'));
  assert.ok(USER_TOOL_SOURCES.includes('steward'), 'tools made from custom tasks are kept by the tool store');
  console.log('ok - steward notes render under the bubble and custom tasks can become tools');
}
