import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {} };

const { inspectAttachmentFile } = await import('../../src/scripts/import/attachment-file-inspector.js');
const {
  createMaidAttachmentsFromFiles,
  createMaidFileAttachmentRegistry,
  MAX_MAID_FILE_ATTACHMENT_BYTES,
} = await import('../../src/scripts/ui/maid-file-attachments.js');
const {
  buildMaidFileAttachmentSummary,
  buildMaidImageAttachmentSummary,
  buildMaidUserContentWithImages,
} = await import('../../src/scripts/agent/maid-attachment-parts.js');
const { createMaidCommandSubmit } = await import('../../src/scripts/ui/maid-command-submit-runtime.js');
const { createMaidTaskInputPersistence } = await import('../../src/scripts/ui/maid-run-resume-utils.js');

const encodeJson = value => new TextEncoder().encode(JSON.stringify(value));
const inspectJson = (name, value) => inspectAttachmentFile({ name, mime: 'application/json', bytes: encodeJson(value) });

// 带 tEXt「chara」块的 PNG（读取不校验 CRC）
const buildCardPng = (card) => {
  const payload = new TextEncoder().encode(`chara\0${Buffer.from(JSON.stringify(card)).toString('base64')}`);
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    return out;
  };
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('tEXt', payload), chunk('IEND', new Uint8Array(0))];
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  parts.forEach((part) => { bytes.set(part, offset); offset += part.length; });
  return bytes;
};

const card = {
  spec: 'chara_card_v2',
  data: {
    name: '测试<b>卡</b>', first_mes: 'hi', alternate_greetings: ['a', 'b'],
    character_book: { entries: [{ content: '卡内条目原文' }] },
    extensions: { regex_scripts: [{ findRegex: '/a/' }], tavern_helper: { scripts: [{ type: 'folder', scripts: [{ type: 'script', name: 's', content: '1' }, { type: 'script', name: 't', content: '2' }] }] } },
  },
};

// 本地识别：按内容判断格式，嵌在卡里的世界书／正则／脚本不当成独立文件
{
  const worldbook = inspectJson('星港.json', { entries: { 0: { key: ['a'], content: 'x' }, 1: { keys: ['b'], content: 'y' } }, boundRegexSets: [{ rules: [] }] });
  assert.deepEqual([worldbook.format, worldbook.label, worldbook.title, worldbook.counts], ['worldbook', '世界书', '星港', { entries: 2, boundRegexSets: 1 }]);
  assert.deepEqual(worldbook.targets, ['global', 'role_card', 'chat_room']);

  const cardJson = inspectJson('card.json', card);
  assert.equal(cardJson.format, 'character_card');
  assert.deepEqual(cardJson.counts, { greetings: 3, worldbookEntries: 1, regexRules: 1, scripts: 2 });
  assert.equal(cardJson.details.cardVersion, 'v2');
  assert.equal(inspectJson('v1.json', { name: 'v1', description: 'd', first_mes: 'f' }).format, 'character_card');
  const v3 = inspectJson('v3.json', { ...card, spec: 'chara_card_v3', spec_version: '3.0', data: { ...card.data, group_only_greetings: ['群聊'], assets: [{ type: 'icon', uri: 'ccdefault:', name: 'main' }, { type: 'emotion', uri: 'embeded://a.png', name: 'joy' }] } });
  assert.equal(v3.details.cardVersion, 'v3');
  assert.deepEqual(v3.diagnostics, ['CCv3 群聊专用开场白 1 个暂不导入', 'CCv3 资源 1 个暂不导入（文件中没有附带）'], 'a JSON card cannot carry embedded assets');
  const withData = inspectJson('v3-data.json', { spec: 'chara_card_v3', data: { name: 'D', first_mes: 'hi', assets: [{ type: 'emotion', name: 'joy', uri: 'data:image/png;base64,AA' }, { type: 'background', name: 'bg', uri: 'https://example.com/bg.png' }] } });
  assert.deepEqual([withData.counts.expressions, withData.counts.backgrounds], [1, 0]);
  assert.match(withData.diagnostics[0], /远程资源（不自动下载）/);
  assert.deepEqual(inspectJson('v3-plain.json', { ...card, spec: 'chara_card_v3' }).diagnostics, [], 'a CCv3 card without unsupported parts has no warnings');

  const regex = inspectJson('re.json', [{ scriptName: 'r', findRegex: '/a/g', replaceString: 'b' }, { scriptName: 'q', findRegex: '/c/', replaceString: '' }]);
  assert.deepEqual([regex.format, regex.counts.rules], ['regex', 2]);
  const script = inspectJson('sc.json', { type: 'script', name: 'x', content: 'console.log(1)' });
  assert.deepEqual([script.format, script.title, script.counts.scripts], ['script', 'x', 1]);
  assert.deepEqual(inspectJson('scripts.json', { scripts: [{ type: 'script', name: 'a', content: '' }, { type: 'folder', scripts: [{ type: 'script', name: 'b', content: '' }] }] }).counts, { scripts: 2 });

  const preset = inspectJson('preset.json', { prompts: [{}], prompt_order: [], temperature: 1 });
  assert.deepEqual([preset.format, preset.targets, preset.details.presetType], ['preset', ['preset_library'], 'openai']);
  assert.equal(inspectJson('sys.json', { name: '系统', content: 'x', post_history: '' }).details.presetType, 'sysprompt');
  assert.equal(inspectJson('ctx.json', { name: '上下文', story_string: '{{char}}' }).details.presetType, 'context');
  const bundle = inspectJson('all.json', { presets: {}, active: {}, enabled: {} });
  assert.deepEqual([bundle.format, bundle.targets], ['preset', []]);
  assert.match(bundle.diagnostics[0], /预设面板/);
  assert.equal(inspectJson('other.json', { foo: 1 }).format, 'unknown_json');
  const broken = inspectAttachmentFile({ name: 'bad.json', bytes: new TextEncoder().encode('﻿{oops') });
  assert.equal(broken.format, 'invalid_json');
  assert.match(broken.diagnostics[0], /JSON 解析失败/);

  // 同一份 JSON 像脚本也像正则：列出候选
  const ambiguous = inspectJson('mixed.json', [{ type: 'script', name: 'x', content: '', findRegex: '/a/', replaceString: '' }]);
  assert.deepEqual(ambiguous.candidates, ['script', 'regex']);

  const pngCard = inspectAttachmentFile({ name: 'card.png', mime: 'image/png', bytes: buildCardPng(card) });
  assert.deepEqual([pngCard.format, pngCard.title, pngCard.details.source], ['character_card', '测试<b>卡</b>', 'png']);
  assert.equal(inspectAttachmentFile({ name: 'photo.png', mime: 'image/png', bytes: buildCardPng(null).slice(0, 8) }).format, 'image');
  console.log('ok - attachment inspector recognises cards, worldbooks, regex and scripts by content');
}

// 通用文件：文本、压缩包、Office 按内容识别并保留原文件；PDF 与二进制明确提示
{
  const { buildZip } = await import('../../src/scripts/utils/zip-archive.js');
  const enc = value => new TextEncoder().encode(value);
  const makeFile = (name, type, bytes) => ({ name, type, size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer });
  const zip = await buildZip([{ path: '资料/笔记.md', bytes: enc('# 笔记') }]);
  const docx = await buildZip([
    { path: '[Content_Types].xml', bytes: enc('<Types/>') },
    { path: 'word/document.xml', bytes: enc('<w:p><w:t>报告正文</w:t></w:p>') },
  ]);
  const warnings = [];
  let seq = 0;
  const registry = createMaidFileAttachmentRegistry();
  const attachments = await createMaidAttachmentsFromFiles([
    makeFile('日志.log', '', enc('第一行\n第二行')),
    // Android 常把未知文件报成 octet-stream：按内容识别
    makeFile('资料包', 'application/octet-stream', zip),
    makeFile('报告.docx', '', docx),
    makeFile('论文.pdf', 'application/pdf', enc('%PDF-1.7\n')),
  ], { registry, createId: () => `gen-${(seq += 1)}`, notify: message => warnings.push(message) });
  assert.deepEqual(attachments.map(item => [item.name, item.file.format, item.mime]), [
    ['日志.log', 'text', 'text/plain'],
    ['资料包', 'archive', 'application/octet-stream'],
    ['报告.docx', 'document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ]);
  assert.deepEqual(Array.from(registry.get('gen-2').bytes), Array.from(zip), 'the original archive is kept for later reading');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /PDF/);
  console.log('ok - maid attachments accept text, archives and Office files by content and report PDFs');
}

// 附件名额：先分类再占名额（不支持的文件不占位），超出的文件不读取并明确提示
{
  const reads = [];
  const makeJson = name => {
    const bytes = encodeJson({ entries: [{ key: ['a'], content: name }] });
    return { name, type: 'application/json', size: bytes.byteLength, arrayBuffer: async () => { reads.push(name); return bytes.slice().buffer; } };
  };
  const warnings = [];
  let seq = 0;
  const attachments = await createMaidAttachmentsFromFiles([
    makeJson('a.json'),
    { name: 'notes.exe', type: 'application/x-msdownload', size: 1, arrayBuffer: async () => new ArrayBuffer(1) },
    makeJson('b.json'),
    makeJson('c.json'),
    makeJson('d.json'),
  ], { registry: createMaidFileAttachmentRegistry(), createId: () => `slot-${(seq += 1)}`, notify: message => warnings.push(message), maxCount: 2 });
  assert.deepEqual(attachments.map(item => item.name), ['a.json', 'b.json'], 'an unsupported file does not use up a slot');
  assert.deepEqual(reads, ['a.json', 'b.json'], 'files beyond the remaining slots are not read');
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /notes\.exe/);
  assert.match(warnings[1], /c\.json/);
  assert.match(warnings[1], /d\.json/);
  const none = [];
  assert.deepEqual(await createMaidAttachmentsFromFiles([makeJson('e.json')], { notify: message => none.push(message), maxCount: 0 }), []);
  assert.match(none[0], /e\.json/, 'a full attachment bar still tells the user which file was left out');
  console.log('ok - maid attachments classify before taking slots and report files left out');
}

// 最近文件只算发送过的；没发送就移除的文件立即释放
{
  const registry = createMaidFileAttachmentRegistry();
  const bytes = new Uint8Array([1, 2, 3]);
  registry.register('sent', { bytes, hash: 'h1', name: 'sent.json', mime: 'application/json', size: 3, inspection: { format: 'worldbook' } });
  registry.register('draft', { bytes, hash: 'h2', name: 'draft.json', mime: 'application/json', size: 3, inspection: { format: 'worldbook' } });
  registry.markSubmitted('sent', { roleCardId: 'p', sessionId: 's' });
  assert.deepEqual(registry.listRecent().map(item => item.id), ['sent'], 'a file the model never saw is not offered as a recent file');
  assert.equal(registry.discardUnsubmitted('sent'), false, 'a sent file stays available for follow-up turns');
  assert.equal(registry.discardUnsubmitted('draft'), true);
  assert.equal(registry.get('draft'), null);
  assert.equal(registry.discardUnsubmitted('unknown'), false);
  console.log('ok - maid file registry lists only sent files as recent and frees removed drafts');
}

// 附件构建：图片照旧压缩；角色卡 PNG 与 JSON 保留原文件，其他类型和超大文件提示不支持
{
  const makeFile = (name, type, bytes) => ({ name, type, size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer });
  const pngBytes = buildCardPng(card);
  const jsonBytes = encodeJson({ entries: [{ key: ['a'], content: 'x' }] });
  const registry = createMaidFileAttachmentRegistry();
  const warnings = [];
  let seq = 0;
  const attachments = await createMaidAttachmentsFromFiles([
    makeFile('card.png', 'image/png', pngBytes),
    makeFile('photo.jpg', 'image/jpeg', new Uint8Array([1, 2, 3])),
    makeFile('星港.json', '', jsonBytes),
    makeFile('tool.exe', 'application/x-msdownload', new Uint8Array([0x4d, 0x5a, 0, 0])),
    { name: 'huge.json', type: 'application/json', size: MAX_MAID_FILE_ATTACHMENT_BYTES + 1, arrayBuffer: async () => { throw new Error('must not read'); } },
  ], {
    registry,
    createId: () => `att-${(seq += 1)}`,
    notify: message => warnings.push(message),
    imageOptions: {
      readFileAsDataUrl: async file => `data:${file.type};base64,AAAA`,
      compressImageDataUrl: async () => 'data:image/jpeg;base64,COMPRESSED',
    },
  });
  assert.deepEqual(attachments.map(item => [item.id, item.kind, item.file?.format || '']), [
    ['att-1', 'image', 'character_card'],
    ['att-2', 'image', ''],
    ['att-3', 'file', 'worldbook'],
  ]);
  assert.equal(attachments[0].url, 'data:image/jpeg;base64,COMPRESSED', 'the vision preview is still compressed');
  assert.deepEqual(registry.get('att-1').bytes, pngBytes, 'the original PNG keeps its card metadata');
  assert.match(attachments[0].hash, /^[0-9a-f]{64}$/);
  assert.equal(registry.get('att-2'), null, 'plain photos are not retained');
  assert.deepEqual([attachments[2].mime, registry.get('att-3').hash], ['application/json', attachments[2].hash]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /tool\.exe/);
  assert.match(warnings[1], /20MB/);

  const small = createMaidFileAttachmentRegistry({ maxBytes: 10 });
  small.register('a', { bytes: new Uint8Array(6) });
  small.register('b', { bytes: new Uint8Array(6) });
  assert.deepEqual([small.get('a'), Boolean(small.get('b'))], [null, true], 'the oldest original is evicted first');
  console.log('ok - maid attachments keep originals for cards and JSON while photos stay compressed');
}

// 模型只看到本地摘要和附件 ID；图片序号与「用户附图」一致；没有导入工具前如实说明
{
  const attachments = [
    { id: 'img-1', kind: 'image', url: 'data:image/jpeg;base64,A', name: 'photo.jpg' },
    { id: 'img-2', kind: 'image', url: 'data:image/jpeg;base64,B', name: 'card.png', file: inspectAttachmentFile({ name: 'card.png', mime: 'image/png', bytes: buildCardPng(card) }) },
    { id: 'file-1', kind: 'file', name: '星港.json', file: inspectJson('星港.json', { entries: [{ key: ['a'], content: 'x' }] }) },
  ];
  const summary = buildMaidFileAttachmentSummary(attachments);
  assert.match(summary, /图片2 同时是角色卡「测试<b>卡<\/b>」：开场白 3，内嵌世界书 1 条，正则 1 条，脚本 2 个（附件ID img-2；可导入到：新建角色卡）/);
  assert.match(summary, /文件1「星港\.json」：世界书「星港」：1 条（附件ID file-1；可导入到：全局、角色卡、聊天室）/);
  assert.match(summary, /导入世界书或正则用 attachment\.import/);
  assert.match(summary, /角色卡用 target new_role_card，导入为新卡但默认不切换/);
  assert.match(summary, /导入后保持关闭/);
  const withRecent = buildMaidFileAttachmentSummary([], { recent: [{ id: 'old-1', name: '旧.json', file: inspectJson('旧.json', { entries: [{ key: ['a'], content: 'x' }] }) }] });
  assert.match(withRecent, /之前上传、尚未导入的文件：\n「旧\.json」：世界书「旧」：1 条（附件ID old-1/);
  assert.doesNotMatch(summary, /卡内条目原文|"content"/, 'file contents never reach the prompt');
  assert.equal(buildMaidImageAttachmentSummary(attachments).split('\n').length, 2, 'file attachments are not counted as images');
  assert.equal(buildMaidUserContentWithImages('看看', attachments).filter(part => part.type === 'image_url').length, 2);
  assert.equal(buildMaidFileAttachmentSummary([attachments[0]]), '');
  console.log('ok - maid prompt receives local file summaries and attachment ids only');
}

// 不支持看图的模型：角色卡 PNG 只去掉画面继续；普通图片照旧拦下
{
  const runSubmit = async (attachments) => {
    const received = [];
    const submit = createMaidCommandSubmit({
      getVoiceRuntime: () => null, getOnboardingRuntime: () => null,
      matchMaidIntent: () => null, hasConfiguredMaidProfile: () => true,
      resolveMaidRuntimeConfig: async () => ({ configured: true }), logger: console,
      checkMaidVisionInput: async () => ({ ok: false, capability: { status: 'unsupported' }, message: '当前模型不支持图片' }),
      maidSettingsStore: { setLastExchange() {}, getLastExchange: () => ({}) },
      buildAppFeatureSearchContextText: () => '',
      getAppContext: () => ({ sessionId: '', roleCardId: '', agentId: 'maid-assistant' }),
      maidAssistantAgent: { runPrompt: async (text, context) => { received.push(context.maidAttachments); return { ok: true, message: 'done' }; } },
      requestMaidToolConfirmation: async () => ({ decision: 'allow' }),
      recordMaidTurnFromResult: async () => {},
    });
    return { result: await submit('导入这张卡', { attachments }), received };
  };
  const cardImage = { id: 'c', kind: 'image', url: 'data:image/jpeg;base64,A', file: { format: 'character_card' } };
  const accepted = await runSubmit([cardImage]);
  assert.equal(accepted.result.ok, true);
  assert.deepEqual([accepted.received[0][0].kind, accepted.received[0][0].url], ['file', '']);
  const rejected = await runSubmit([cardImage, { id: 'p', kind: 'image', url: 'data:image/jpeg;base64,B' }]);
  assert.deepEqual([rejected.result.ok, rejected.received.length], [false, 0]);
  console.log('ok - text-only models still receive character card summaries without the picture');
}

// 恢复任务只保存图片，文件附件不进入图片存储
{
  const persisted = [];
  const persistence = createMaidTaskInputPersistence({ native: false, referenceStore: { persist: async (items) => { persisted.push(...items); return items.map(item => ({ url: item.url })); } } });
  await persistence.persist([{ id: 'f', kind: 'file', name: 'a.json' }, { id: 'i', kind: 'image', url: 'data:image/jpeg;base64,A' }], {});
  assert.deepEqual(persisted.map(item => item.id), ['i']);
  console.log('ok - task resume persistence stores images only');
}

// 导入服务：世界书冲突／副本／覆盖、三种绑定、附带正则去重、写入后绑定失败如实报告；正则校验、去重与三种目标
{
  const { createAttachmentImportService, nextAvailableWorldbookName } = await import('../../src/scripts/import/attachment-import-service.js');
  const makeEntry = (format, json, name = 'file.json') => {
    const bytes = encodeJson(json);
    return { bytes, hash: `hash-${name}`, name, inspection: inspectAttachmentFile({ name, mime: 'application/json', bytes }) };
  };
  const setup = ({ worlds = {}, bindFails = false } = {}) => {
    const saved = {};
    const binds = [];
    const regexState = { global: { enabled: true, rules: [{ id: 'g1', findRegex: '/old/', replaceString: '' }] }, sessions: {}, sets: [] };
    const attachments = {
      wb: makeEntry('worldbook', { entries: { 0: { key: ['港'], content: '星港' } }, boundRegexSets: [{ name: '美化', rules: [{ findRegex: '/a/', replaceString: 'b' }, { findRegex: '/a/', replaceString: 'b' }] }] }, '星港.json'),
      re: makeEntry('regex', [{ scriptName: 'ok', findRegex: '/x/g', replaceString: 'y' }, { scriptName: 'bad', findRegex: '/(/', replaceString: '' }, { scriptName: 'dup', findRegex: '/old/', replaceString: '' }], 're.json'),
    };
    const service = createAttachmentImportService({
      getAttachment: id => attachments[id] || null,
      worldbooks: {
        listIds: async () => Object.keys({ ...worlds, ...saved }),
        getSnapshot: async id => (worlds[id] || saved[id] ? { exists: true, revision: 1, generation: 1, data: worlds[id] || saved[id] } : { exists: false, revision: 0, generation: 0, data: null }),
        save: async (id, world) => { saved[id] = world; },
      },
      bindWorldbook: {
        global: async id => { if (bindFails) throw new Error('bind down'); binds.push(['global', id]); },
        chatRoom: async (sid, id) => binds.push(['chat_room', sid, id]),
        roleCard: async (rid, id) => binds.push(['role_card', rid, id]),
      },
      regex: {
        ready: async () => true,
        listLocalSets: () => regexState.sets,
        upsertLocalSet: async set => { const id = `set-${regexState.sets.length + 1}`; regexState.sets.push({ ...set, id }); return id; },
        getGlobal: () => regexState.global,
        setGlobal: async value => { regexState.global = value; },
        getSession: sid => regexState.sessions[sid] || null,
        setSession: async (sid, value) => { regexState.sessions[sid] = value; },
      },
    });
    return { service, saved, binds, regexState };
  };

  assert.equal(nextAvailableWorldbookName('星港', ['星港', '星港 (2)']), '星港 (3)');

  const fresh = setup();
  const plan = await fresh.service.planWorldbookImport({ attachmentId: 'wb' });
  assert.deepEqual([plan.worldId, plan.entryCount, plan.conflict, plan.boundRegexSets.length], ['星港', 1, null, 1]);
  const done = await fresh.service.commitWorldbookImport(plan, { target: { type: 'role_card', roleCardId: 'persona-1' } });
  assert.equal(done.ok, true);
  assert.deepEqual(fresh.binds, [['role_card', 'persona-1', '星港']]);
  assert.equal(fresh.saved['星港'].entries.length, 1);
  assert.deepEqual([done.regex.importedRuleCount, done.regex.skippedRuleCount], [1, 1], 'duplicate rules inside the file are skipped');
  assert.deepEqual(fresh.regexState.sets[0].bind, { type: 'world', worldId: '星港' });

  const clash = setup({ worlds: { 星港: { entries: [{ content: 'old' }, { content: 'old2' }] } } });
  const blocked = await clash.service.planWorldbookImport({ attachmentId: 'wb' });
  assert.deepEqual(blocked.conflict, { existingCount: 2, incomingCount: 1 });
  assert.equal((await clash.service.commitWorldbookImport(blocked)).reason, 'worldbook_name_conflict');
  assert.equal(clash.saved['星港'], undefined, 'a name conflict never overwrites silently');
  const copy = await clash.service.planWorldbookImport({ attachmentId: 'wb', conflict: 'copy' });
  assert.deepEqual([copy.worldId, copy.conflict], ['星港 (2)', null]);
  const overwrite = await clash.service.planWorldbookImport({ attachmentId: 'wb', conflict: 'overwrite' });
  assert.equal(overwrite.overwrite, true);
  assert.equal((await clash.service.commitWorldbookImport(overwrite, { target: { type: 'chat_room', sessionId: 'rp:s1' }, includeBoundRegex: false })).overwritten, true);
  assert.deepEqual(clash.binds, [['chat_room', 'rp:s1', '星港']]);

  const failing = setup({ bindFails: true });
  const partial = await failing.service.commitWorldbookImport(await failing.service.planWorldbookImport({ attachmentId: 'wb' }), { target: { type: 'global' }, includeBoundRegex: false });
  assert.deepEqual([partial.ok, partial.partial, partial.binding.status, Boolean(failing.saved['星港'])], [false, true, 'failed', true]);

  assert.equal((await fresh.service.planWorldbookImport({ attachmentId: 're' })).reason, 'attachment_format_mismatch');
  assert.equal((await fresh.service.planWorldbookImport({ attachmentId: 'gone' })).reason, 'attachment_not_found');

  const rx = setup();
  const globalPlan = await rx.service.planRegexImport({ attachmentId: 're', target: { type: 'global' } });
  assert.deepEqual(globalPlan.items.map(item => [item.label, item.status, item.reason || '']), [['ok', 'planned', ''], ['bad', 'failed', 'invalid_regex'], ['dup', 'skipped', 'duplicate_rule']]);
  const globalDone = await rx.service.commitRegexImport(globalPlan);
  assert.deepEqual([globalDone.importedCount, rx.regexState.global.rules.length, rx.regexState.global.enabled], [1, 2, true]);
  await rx.service.commitRegexImport(await rx.service.planRegexImport({ attachmentId: 're', target: { type: 'chat_room', sessionId: 'rp:s1' } }));
  assert.equal(rx.regexState.sessions['rp:s1'].rules.length, 2);
  const worldDone = await rx.service.commitRegexImport(await rx.service.planRegexImport({ attachmentId: 're', target: { type: 'worldbook', worldId: '星港' } }));
  assert.deepEqual([worldDone.setId, rx.regexState.sets[0].bind.worldId, rx.regexState.sets[0].name], ['set-1', '星港', 'ok 等 2 条 (星港)']);
  assert.equal((await rx.service.planRegexImport({ attachmentId: 're', target: { type: 'role_card' } })).reason, 'regex_target_unsupported');
  console.log('ok - attachment import service plans and commits worldbook and regex imports without silent overwrites');
}

// 附件工具：无冲突直接导入；同一文件同一目标不重复；「current」按发送时的卡；覆盖／替换卡绑定／正则需要确认；不支持的格式如实拒绝
{
  const { createAttachmentImportAgentTools } = await import('../../src/scripts/agent/tools/attachment-import-tools.js');
  const { createAttachmentImportService } = await import('../../src/scripts/import/attachment-import-service.js');
  const registry = createMaidFileAttachmentRegistry();
  const register = (id, name, json) => {
    const bytes = encodeJson(json);
    registry.register(id, { bytes, hash: `hash-${id}`, name, mime: 'application/json', size: bytes.length, inspection: inspectAttachmentFile({ name, mime: 'application/json', bytes }) });
  };
  register('wb', '星港.json', { entries: [{ key: ['港'], content: '星港' }] });
  register('wb-regex', '带正则.json', { entries: [{ key: ['a'], content: 'x' }], boundRegexSets: [{ name: '美化', rules: [{ findRegex: '/a/', replaceString: 'b' }] }] });
  register('re', 're.json', [{ scriptName: 'r', findRegex: '/x/', replaceString: 'y' }]);
  register('card', 'card.json', card);
  const worlds = { 旧书: { entries: [] } };
  const binds = [];
  const regexState = { global: { enabled: true, rules: [] }, sets: [] };
  const personas = [{ id: 'p-test', name: '测试', source: { worldbookId: '' } }, { id: 'p-other', name: '别的卡', source: { worldbookId: '旧书' } }];
  const service = createAttachmentImportService({
    getAttachment: id => registry.get(id),
    worldbooks: {
      listIds: async () => Object.keys(worlds),
      getSnapshot: async id => (worlds[id] ? { exists: true, revision: 1, generation: 1, data: worlds[id] } : { exists: false, revision: 0, generation: 0, data: null }),
      save: async (id, world) => { worlds[id] = world; },
    },
    bindWorldbook: { global: async id => binds.push(['global', id]), chatRoom: async (sid, id) => binds.push(['chat_room', sid, id]), roleCard: async (pid, id) => binds.push(['role_card', pid, id]) },
    regex: {
      ready: async () => true, listLocalSets: () => regexState.sets,
      upsertLocalSet: async set => { regexState.sets.push(set); return `set-${regexState.sets.length}`; },
      getGlobal: () => regexState.global, setGlobal: async value => { regexState.global = value; },
      getSession: () => null, setSession: async () => {},
    },
  });
  const { extractArchiveEntryToLibrary } = await import('../../src/scripts/agent/tools/attachment-file-tools.js');
  const [inspectTool, importTool] = createAttachmentImportAgentTools({
    extractArchiveEntry: extractArchiveEntryToLibrary,
    getAttachmentRegistry: () => registry,
    getImportService: () => service,
    personaStore: { get: id => personas.find(item => item.id === id) || null, getAll: () => personas },
    contactsStore: { getContact: id => (id === 'c1' ? { id: 'c1', name: '阿凯' } : null), listContacts: () => [{ id: 'c1', name: '阿凯' }] },
    chatStore: { listSessions: async () => ['c1'] },
    readWorldbookSnapshot: async id => (worlds[id] ? { exists: true, data: worlds[id] } : { exists: false }),
  });
  const run = async (args, { allow = true, context = {} } = {}) => {
    const preflight = await importTool.safety.preflight(args, context);
    const toolSafety = preflight.destructive ? { decision: allow ? 'allow' : 'deny', request: preflight } : { decision: 'not_required' };
    return { preflight, result: await importTool.execute(args, { ...context, toolSafety }) };
  };

  registry.markSubmitted('wb', { roleCardId: 'p-test', sessionId: 'rp:p-test' });
  const direct = await run({ attachmentId: 'wb', target: 'role_card', roleCard: 'current' }, { context: { roleCardId: 'p-other', sessionId: 'rp:p-other' } });
  assert.equal(direct.preflight.destructive, false, 'a new worldbook bound to a card without one needs no confirmation');
  assert.deepEqual([direct.result.ok, direct.result.worldbookId, direct.result.verified, direct.result.targetName], [true, '星港', true, '测试']);
  assert.deepEqual(binds, [['role_card', 'p-test', '星港']], '"current" means the card when the file was sent, not after switching');
  const again = await run({ attachmentId: 'wb', target: 'role_card', roleCard: 'current' });
  assert.equal(again.result.alreadyImported, true);
  assert.equal(binds.length, 1, 'the same file is not imported twice into the same target');
  assert.deepEqual(registry.listRecent().map(item => item.id).includes('wb'), false, 'imported files leave the recent list');

  const conflict = await run({ attachmentId: 'wb', target: 'global' });
  assert.equal(conflict.result.reason, 'worldbook_name_conflict');
  const copied = await run({ attachmentId: 'wb', target: 'global', onNameConflict: 'copy' });
  assert.deepEqual([copied.result.worldbookId, binds.at(-1)], ['星港 (2)', ['global', '星港 (2)']]);
  const overwrite = await run({ attachmentId: 'wb', target: 'none', onNameConflict: 'overwrite' }, { allow: false });
  assert.equal(overwrite.preflight.allowAlways, false);
  assert.match(overwrite.preflight.details.items[0].label, /覆盖同名世界书/);
  assert.equal(overwrite.result.reason, 'confirmation_required', 'a denied overwrite never writes');

  const replace = await run({ attachmentId: 'wb-regex', target: 'role_card', roleCard: '别的卡' });
  assert.deepEqual(replace.preflight.details.items.map(item => item.id), ['replace_binding', 'regex']);
  assert.equal(replace.preflight.danger, true);
  assert.deepEqual([replace.result.ok, replace.result.regex.importedRuleCount, binds.at(-1)], [true, 1, ['role_card', 'p-other', '带正则']]);

  const room = await run({ attachmentId: 'wb-regex', target: 'chat_room', chatRoom: '阿凯', name: '房间书' });
  assert.deepEqual(binds.at(-1), ['chat_room', 'c1', '房间书']);
  assert.equal(room.result.ok, true);

  const regexRun = await run({ attachmentId: 're', target: 'role_card_worldbook', roleCard: '别的卡' });
  assert.equal(regexRun.preflight.kind, 'attachment.import');
  assert.match(regexRun.preflight.message, /「别的卡」|旧书/);
  assert.deepEqual([regexRun.result.ok, regexState.sets.at(-1).bind], [true, { type: 'world', worldId: '旧书' }]);
  assert.equal((await run({ attachmentId: 're', target: 'role_card_worldbook', roleCard: '测试' })).result.reason, 'role_card_has_no_worldbook');

  assert.equal((await run({ attachmentId: 'card', target: 'global' })).result.reason, 'target_not_supported_for_format');
  assert.equal((await run({ attachmentId: 'wb', target: 'worldbook' })).result.reason, 'target_not_supported_for_format');
  assert.equal((await run({ attachmentId: 'missing', target: 'global' })).result.reason, 'attachment_not_found');
  assert.equal((await run({ attachmentId: 'wb-regex', target: 'role_card', roleCard: '不存在' })).result.reason, 'role_card_not_found');

  const inspected = await inspectTool.execute({ attachmentId: 're' });
  assert.deepEqual([inspected.attachments[0].format, inspected.attachments[0].ruleNames], ['regex', ['r']]);
  registry.markSubmitted('card', { roleCardId: 'p-test', sessionId: 'rp:p-test' });
  assert.deepEqual((await inspectTool.execute({})).attachments.map(item => item.attachmentId), ['card'], 'only sent files that are not imported yet are listed');

  // 压缩包里的世界书：带 entry 直接导入（先取出成单独文件，同一路径只取一次）
  const { buildZip } = await import('../../src/scripts/utils/zip-archive.js');
  const zipBytes = await buildZip([{ path: '书/灯塔.json', bytes: encodeJson({ name: '灯塔', entries: [{ key: ['灯'], content: '灯塔' }] }) }]);
  registry.register('pack', { bytes: zipBytes, hash: 'a'.repeat(64), name: '书.zip', mime: 'application/zip', inspection: { format: 'archive' } });
  registry.markSubmitted('pack', { roleCardId: 'p-test', sessionId: 'rp:p-test' });
  const fromZip = await run({ attachmentId: 'pack', entry: '书/灯塔.json', target: 'role_card', roleCard: 'current' });
  assert.deepEqual([fromZip.result.ok, fromZip.result.worldbookId], [true, '灯塔']);
  assert.deepEqual(binds.at(-1), ['role_card', 'p-test', '灯塔'], '"current" follows the archive the entry came from');
  const derived = registry.list().filter(item => item.parentId === 'pack');
  assert.deepEqual(derived.map(item => [item.entryPath, item.origin]), [['书/灯塔.json', 'archive']]);
  assert.equal((await run({ attachmentId: 'pack', entry: '书/灯塔.json', target: 'role_card', roleCard: 'current' })).result.alreadyImported, true);
  assert.equal((await run({ attachmentId: 'pack', entry: '没有.json', target: 'global' })).result.reason, 'entry_not_found');
  console.log('ok - attachment tools import worldbooks and regex with confirmations only where content is replaced or rewritten');
}

// 角色卡走导入服务：默认全导、不切换；含正则时一次确认；重名先问；失败回滚如实返回。脚本导入后保持关闭，作用域 ID 用实际卡／预设
{
  const { createAttachmentImportAgentTools } = await import('../../src/scripts/agent/tools/attachment-import-tools.js');
  const registry = createMaidFileAttachmentRegistry();
  const register = (id, name, json) => {
    const bytes = encodeJson(json);
    registry.register(id, { bytes, hash: `hash-${id}`, name, mime: 'application/json', size: bytes.length, inspection: inspectAttachmentFile({ name, mime: 'application/json', bytes }) });
  };
  register('card', 'card.json', card);
  register('card-plain', 'plain.json', { spec: 'chara_card_v2', data: { name: '素卡', first_mes: 'hi' } });
  register('card-dup', 'dup.json', { spec: 'chara_card_v2', data: { name: '测试', first_mes: 'hi' } });
  register('card-broken', 'broken.json', { spec: 'chara_card_v2', data: { name: '坏卡', first_mes: 'hi' } });
  register('scripts', 'scripts.json', { scripts: [{ type: 'script', name: 'a', content: '1' }, { type: 'folder', scripts: [{ type: 'script', name: 'b', content: '2' }] }] });
  register('preset-json', 'preset.json', { prompts: [{}], prompt_order: [], temperature: 1 });
  const personas = [{ id: 'p-test', name: '测试', source: {} }];
  const commits = [];
  const scriptImports = [];
  const plans = { 'card.json': { regexRules: 1, name: '测试<b>卡</b>' }, 'plain.json': { regexRules: 0, name: '素卡' }, 'dup.json': { regexRules: 0, name: '测试', conflict: true }, 'broken.json': { regexRules: 0, name: '坏卡' } };
  const [, importTool] = createAttachmentImportAgentTools({
    getAttachmentRegistry: () => registry,
    getImportService: () => null,
    personaStore: { get: id => personas.find(item => item.id === id) || null, getAll: () => personas },
    planCharacterCardFile: async ({ name, bytes }) => {
      const info = plans[name];
      return { ok: true, displayName: info.name, nameConflict: Boolean(info.conflict), hasSystemPrompt: false, bytes: bytes.length,
        counts: { greetings: 1, worldEntries: 2, regexRules: info.regexRules, scripts: 0, mvuVariables: 0 } };
    },
    commitCharacterCardPlan: async (planned, options) => {
      commits.push({ name: planned.displayName, ...options });
      if (planned.displayName === '坏卡') return { ok: false, reason: 'character_card_import_failed', step: 'worldbook', rolledBack: true };
      return { ok: true, personaId: `p-${commits.length}`, displayName: planned.displayName, activated: options.activate, worldbookId: `${planned.displayName}书`,
        worldEntryCount: options.include.worldbook ? 2 : 0, greetingCount: 1, regexRuleCount: options.include.regex ? planned.counts.regexRules : 0, scripts: null, systemPresetId: '', mvuConverted: false };
    },
    scriptStore: { importTavernHelperScripts: async (args) => { scriptImports.push(args); return { count: 2, ids: ['s1', 's2'], runnableIds: ['s1'], compatibility: { runnableCount: 1, blockedCount: 1, blocked: [{ id: 's2', name: 'b' }] } }; } },
    presetStore: { state: { presets: { openai: { 'preset-1': { name: '主预设' }, 'preset-2': { name: '备用' } } } }, getResolvedActive: () => ({ presetId: 'preset-1' }) },
    getScriptSettings: () => ({ scriptEnabled: false }),
  });
  const run = async (args, context = {}, allow = true) => {
    const preflight = await importTool.safety.preflight(args, context);
    const toolSafety = preflight.destructive ? { decision: allow ? 'allow' : 'deny', request: preflight } : { decision: 'not_required' };
    return { preflight, result: await importTool.execute(args, { ...context, toolSafety }) };
  };
  const plain = await run({ attachmentId: 'card-plain', target: 'new_role_card' });
  assert.equal(plain.preflight.destructive, false, 'a card without regex imports without a confirmation');
  assert.deepEqual([plain.result.ok, plain.result.switchedToNewCard, commits[0].activate], [true, false, false], 'the import does not switch cards by default');
  assert.deepEqual(Object.values(commits[0].include).every(Boolean), true, 'everything is imported by default');

  const withRegex = await run({ attachmentId: 'card', target: 'new_role_card', switchTo: true, exclude: ['scripts'] });
  assert.deepEqual(withRegex.preflight.details.items.map(item => item.id), ['worldbook', 'greetings', 'regex', 'activate']);
  assert.equal(withRegex.preflight.allowAlways, false);
  assert.deepEqual([withRegex.result.switchedToNewCard, commits[1].include.scripts, withRegex.result.excluded], [true, false, ['scripts']]);
  assert.equal((await run({ attachmentId: 'card', target: 'new_role_card' })).result.alreadyImported, true);

  assert.equal((await run({ attachmentId: 'card-dup', target: 'new_role_card' })).result.reason, 'role_card_name_conflict');
  assert.equal((await run({ attachmentId: 'card-dup', target: 'new_role_card', onNameConflict: 'copy' })).result.ok, true);
  const broken = await run({ attachmentId: 'card-broken', target: 'new_role_card' });
  assert.deepEqual([broken.result.ok, broken.result.step, broken.result.rolledBack], [false, 'worldbook', true]);

  const toCard = await run({ attachmentId: 'scripts', target: 'role_card', roleCard: '测试' });
  assert.equal(toCard.preflight.destructive, false);
  assert.deepEqual([scriptImports[0].scope, scriptImports[0].scopeId, scriptImports[0].scripts.length], ['character', 'p-test', 2]);
  assert.deepEqual([toCard.result.ok, toCard.result.enabled, toCard.result.runnableCount, toCard.result.scriptsRunGlobally], [true, false, 1, false]);
  await run({ attachmentId: 'scripts', target: 'preset', preset: 'current' }, { sessionId: 'rp:p-test' });
  assert.deepEqual([scriptImports[1].scope, scriptImports[1].scopeId], ['preset', 'preset-1']);
  assert.equal((await run({ attachmentId: 'scripts', target: 'preset', preset: '不存在' })).result.reason, 'preset_not_found');
  assert.equal((await run({ attachmentId: 'preset-json', target: 'global' })).result.reason, 'target_not_supported_for_format');
  console.log('ok - character cards import through the shared service by default without switching, and scripts are imported disabled');
}

// 预设：走预设面板同一导入流程并切换；只有写入附带正则时确认；exclude 排除；整套设定档交给面板
{
  const { createAttachmentImportAgentTools } = await import('../../src/scripts/agent/tools/attachment-import-tools.js');
  const registry = createMaidFileAttachmentRegistry();
  const register = (id, name, json) => {
    const bytes = encodeJson(json);
    registry.register(id, { bytes, hash: `hash-${id}`, name, mime: 'application/json', size: bytes.length, inspection: inspectAttachmentFile({ name, mime: 'application/json', bytes }) });
  };
  register('plain', '平淡.json', { prompts: [], prompt_order: [], temperature: 1 });
  register('with-regex', '带正则.json', { prompts: [], temperature: 1, boundRegexSets: [{ name: 'a', rules: [] }], extensions: { tavern_helper: { scripts: [{ type: 'script', name: 's', content: '' }] } } });
  register('bundle', '整套.json', { presets: {}, active: {}, enabled: {} });
  const calls = [];
  const [, importTool] = createAttachmentImportAgentTools({
    getAttachmentRegistry: () => registry,
    importPresetJson: async (args) => { calls.push(args); return { ok: true, presetId: `p-${calls.length}`, presetType: 'openai', name: args.fileName.replace('.json', ''), regex: null, scripts: null }; },
    inspectPresetBindings: json => ({ regexSetCount: (json.boundRegexSets || []).length, scriptCount: json.extensions ? 1 : 0 }),
  });
  const run = async (args, allow = true) => {
    const preflight = await importTool.safety.preflight(args, {});
    const toolSafety = preflight.destructive ? { decision: allow ? 'allow' : 'deny', request: preflight } : { decision: 'not_required' };
    return { preflight, result: await importTool.execute(args, { toolSafety }) };
  };
  const plain = await run({ attachmentId: 'plain', target: 'preset_library' });
  assert.equal(plain.preflight.destructive, false);
  assert.deepEqual([plain.result.ok, plain.result.switchedToPreset, plain.result.presetName], [true, true, '平淡']);
  assert.deepEqual(calls[0].decisions, { includeRegex: true, includeScripts: true });
  const regexed = await run({ attachmentId: 'with-regex', target: 'preset_library' });
  assert.deepEqual(regexed.preflight.details.items.map(item => item.id), ['regex', 'scripts']);
  assert.equal(regexed.preflight.allowAlways, false);
  assert.equal(calls.length, 2);
  const registry2Free = await run({ attachmentId: 'with-regex', target: 'preset_library', exclude: ['regex', 'scripts'] });
  assert.equal(registry2Free.result.alreadyImported, true, 'the same preset file is not imported twice');
  register('with-regex-2', '带正则2.json', { prompts: [], temperature: 1, boundRegexSets: [{ name: 'a', rules: [] }] });
  const excluded = await run({ attachmentId: 'with-regex-2', target: 'preset_library', exclude: ['regex'] });
  assert.equal(excluded.preflight.destructive, false, 'excluding regex removes the confirmation');
  assert.deepEqual(calls.at(-1).decisions, { includeRegex: false, includeScripts: true });
  assert.equal((await run({ attachmentId: 'bundle', target: 'preset_library' })).result.reason, 'preset_bundle_requires_panel');
  console.log('ok - presets import through the panel flow, switch like the manual import and confirm only bundled regex');
}

// 直接导入 .js：按一个脚本导入，源码原样保留，导入后保持关闭
{
  const { createAttachmentImportAgentTools } = await import('../../src/scripts/agent/tools/attachment-import-tools.js');
  const source = 'console.log("hello");\n// 第二行';
  const bytes = new TextEncoder().encode(source);
  const inspected = inspectAttachmentFile({ name: '计数器.js', mime: 'text/javascript', bytes });
  assert.deepEqual([inspected.format, inspected.title, inspected.details.source, inspected.targets], ['script', '计数器', 'js', ['global', 'role_card', 'preset']]);
  assert.match(inspectAttachmentFile({ name: 'empty.js', mime: '', bytes: new Uint8Array(0) }).diagnostics[0], /为空/);

  const registry = createMaidFileAttachmentRegistry();
  const built = await createMaidAttachmentsFromFiles([{ name: '计数器.js', type: '', size: bytes.length, arrayBuffer: async () => bytes.slice().buffer }], { registry, createId: () => 'js-1' });
  assert.deepEqual([built[0].kind, built[0].mime, built[0].file.format], ['file', 'text/javascript', 'script']);

  const imports = [];
  const [, importTool] = createAttachmentImportAgentTools({
    getAttachmentRegistry: () => registry,
    scriptStore: { importTavernHelperScripts: async (args) => { imports.push(args); return { count: 1, ids: ['s1'], runnableIds: ['s1'], compatibility: { runnableCount: 1, blockedCount: 0, blocked: [] } }; } },
  });
  const args = { attachmentId: 'js-1', target: 'global' };
  await importTool.safety.preflight(args, {});
  const result = await importTool.execute(args, { toolSafety: { decision: 'not_required' } });
  assert.deepEqual([result.ok, result.enabled, imports[0].scope, imports[0].scripts[0].name, imports[0].scripts[0].content], [true, false, 'global', '计数器', source]);
  console.log('ok - a .js attachment imports as one disabled script with its source unchanged');
}

// 导入结果的「打开」按钮：只为成功的导入生成，按资源去重，最多 3 个
{
  const { buildMaidImportOpenActions } = await import('../../src/scripts/ui/maid-import-result-actions.js');
  const opened = [];
  const openers = {
    worldbook: id => opened.push(['worldbook', id]),
    roleCard: id => opened.push(['card', id]),
    preset: id => opened.push(['preset', id]),
    regex: () => opened.push(['regex']),
    script: () => opened.push(['script']),
  };
  const step = (output, status = 'succeeded') => ({ toolName: 'attachment.import', status, output: { ok: true, ...output } });
  const actions = buildMaidImportOpenActions([
    step({ format: 'worldbook', worldbookId: '星港' }),
    step({ format: 'worldbook', worldbookId: '星港' }),
    step({ format: 'regex' }, 'failed'),
    { toolName: 'worldbook.read', status: 'succeeded', output: { ok: true, format: 'worldbook', worldbookId: 'x' } },
    step({ format: 'character_card', roleCardId: 'p-1', roleCardName: '船长' }),
    step({ format: 'preset', presetId: 'preset-9' }),
    step({ format: 'script' }),
  ], openers);
  assert.deepEqual(actions.map(item => item.label), ['打开世界书「星港」', '打开角色卡「船长」', '打开预设']);
  actions.forEach(item => item.onClick());
  assert.deepEqual(opened, [['worldbook', '星港'], ['card', 'p-1'], ['preset', 'preset-9']]);
  assert.deepEqual(buildMaidImportOpenActions([step({ format: 'worldbook', worldbookId: 'a' }, 'failed')], openers), []);
  console.log('ok - successful imports add open buttons to the maid result');
}

// CCv3：PNG 优先读 ccv3；V3 字段规范化；.charx 原生解包结果与错误提示；女仆附件识别 .charx
{
  const { extractCharacterCardFromPng, normalizeCharacterCard, readCharxCard } = await import('../../src/scripts/utils/character-card.js');
  const v2 = { spec: 'chara_card_v2', data: { name: 'V2 副本', first_mes: 'hi' } };
  const v3card = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'V3 正本', first_mes: 'hi', nickname: '小三', group_only_greetings: ['大家好'], assets: [{ type: 'icon', uri: 'ccdefault:', name: 'main' }] } };
  const chunk = (keyword, json) => new TextEncoder().encode(`${keyword}\0${Buffer.from(JSON.stringify(json)).toString('base64')}`);
  const png = (...payloads) => {
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];
    for (const data of [...payloads, null]) {
      const type = data ? 'tEXt' : 'IEND';
      const body = data || new Uint8Array(0);
      const out = new Uint8Array(12 + body.length);
      new DataView(out.buffer).setUint32(0, body.length);
      out.set(new TextEncoder().encode(type), 4);
      out.set(body, 8);
      parts.push(out);
    }
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    parts.forEach((part) => { bytes.set(part, offset); offset += part.length; });
    return bytes;
  };
  const both = extractCharacterCardFromPng(png(chunk('chara', v2), chunk('ccv3', v3card)).buffer);
  assert.deepEqual([both.keyword, both.json.data.name, both.keywords], ['ccv3', 'V3 正本', ['ccv3', 'chara']], 'ccv3 wins over the V2 fallback copy');
  assert.equal(extractCharacterCardFromPng(png(chunk('chara', v2)).buffer).keyword, 'chara');
  const normalized = normalizeCharacterCard(v3card);
  assert.deepEqual([normalized.format, normalized.nickname, normalized.group_only_greetings, normalized.specVersion], ['ccv3', '小三', ['大家好'], '3.0']);
  assert.equal(normalizeCharacterCard(v2).format, 'tavern_v2');
  assert.equal(normalizeCharacterCard(v2).nickname, undefined, 'V2 cards gain no V3 fields');

  const charx = await readCharxCard(new Uint8Array([1, 2]), { invoke: async (command, args) => {
    assert.deepEqual([command, args.bytes], ['read_charx', [1, 2]]);
    return { cardText: JSON.stringify(v3card), entries: [{ path: 'card.json', size: 10 }], icon: { path: 'assets/icon.png', mime: 'image/png', base64: 'QUJD' } };
  } });
  assert.deepEqual([charx.json.data.name, charx.avatarDataUrl, charx.entries.length], ['V3 正本', 'data:image/png;base64,QUJD', 1]);
  const failWith = code => readCharxCard(new Uint8Array(0), { invoke: async () => { throw new Error(code); } });
  await assert.rejects(failWith('charx_missing_card_json'), /根目录缺少 card\.json/);
  await assert.rejects(failWith('charx_unsafe_path:../a'), /不安全的资源路径/);
  await assert.rejects(failWith('charx_encrypted'), /加密/);
  await assert.rejects(failWith('charx_too_large'), /资源过大/);

  const registry = createMaidFileAttachmentRegistry();
  const zipBytes = new Uint8Array([80, 75, 3, 4]);
  const built = await createMaidAttachmentsFromFiles([{ name: '船长.charx', type: '', size: 4, arrayBuffer: async () => zipBytes.slice().buffer }], {
    registry, createId: () => 'charx-1', readCharx: async () => ({ json: v3card, entries: [{}, {}], avatarDataUrl: '' }),
  });
  assert.deepEqual([built[0].kind, built[0].mime, built[0].file.format, built[0].file.details.source, built[0].file.details.cardVersion], ['file', 'application/zip', 'character_card', 'charx', 'v3']);
  assert.deepEqual(registry.get('charx-1').bytes, zipBytes, 'the original .charx bytes are kept for the import');
  const warnings = [];
  const rejected = await createMaidAttachmentsFromFiles([{ name: '坏.charx', type: '', size: 4, arrayBuffer: async () => zipBytes.slice().buffer }], {
    registry, notify: message => warnings.push(message), readCharx: async () => { throw new Error('无效的 .charx：根目录缺少 card.json。'); },
  });
  assert.deepEqual([rejected.length, /根目录缺少/.test(warnings[0])], [0, true]);
  console.log('ok - CCv3 PNG prefers ccv3, V3 fields are normalized and .charx attachments are recognised safely');
}
