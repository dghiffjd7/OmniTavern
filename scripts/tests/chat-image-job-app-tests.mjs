import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createChatImageJobRuntime } from '../../src/scripts/ui/chat/chat-image-job-runtime.js';
import { createSessionAsyncWorkRuntime } from '../../src/scripts/ui/chat/session-async-work-runtime-utils.js';
import { buildGeneratedImageMessagePatch } from '../../src/scripts/ui/media-generation-adapter-utils.js';
import { resolveImageReferenceCapability } from '../../src/scripts/ui/media-generation-service.js';
import { createDefaultImageGenerationPreset, mergeImageGenerationRequestOptions, resolveImageNegativePromptCapability } from '../../src/scripts/ui/image-generation-params-utils.js';
import { createImagePromptRuntime } from '../../src/scripts/ui/image-prompt/image-prompt-runtime.js';
import { normalizeImageGenerationReferenceItems, getGeneratedImageReferenceItems } from '../../src/scripts/ui/image-generation-reference-utils.js';
import { createImageGenerationReferenceStore } from '../../src/scripts/ui/image-generation-reference-store.js';
import { createImageGenerationReplayRuntime, resolveImageGenerationReplayConfig } from '../../src/scripts/ui/chat/image-generation-replay-runtime.js';

const source = await readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
const extract = (start, end) => {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, `Missing app contract: ${start}`);
  return source.slice(first, last);
};
const runSource = extract("let lastChatImageGenerationError = '';", 'const isCreativeExecutionTaskStatusTerminal');
const retrySource = extract('const retryChatGeneratedMediaFailure =', 'const openChatImageGenerationFlow =');
const replaySource = extract('const repeatChatImageGeneration =', 'const retryChatGeneratedMediaFailure =');
const replayActionSource = extract("if (action === 'repeat-image-generation')", "if (action === 'cancel-media-generation')");
const loadSource = extract('const ensureRecentMessagesAndWorlds =', 'const refreshRenderedMessageAvatars =');
const cancelSource = extract("if (action === 'cancel-media-generation')", "if (action === 'generate-image')");
const contextSource = source.match(/const getChatImageJobContextKey =[^\n]+/)?.[0];
assert(contextSource, 'The app must capture both storage scope and archive identity');
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const fixture = ({ configGate = null, worldGate = null, imageConfig = null } = {}) => {
  const sid = 'rp:fixture';
  const rows = new Map();
  const writes = [], rendered = [], calls = [], toasts = [];
  let archive = 'archive-1', sequence = 0;
  const chatStore = {
    scopeId: 'scope-a', getCurrent: () => sid, getCurrentArchiveId: () => archive,
    findMessage: (mid, room = sid) => rows.get(key(mid, room)) || null,
    updateMessage: (mid, patch, room) => {
      const prior = chatStore.findMessage(mid, room);
      if (!prior) return null;
      const updated = { ...prior, ...patch };
      rows.set(key(mid, room), updated);
      writes.push({ context: contextKey(), mid, patch });
      return updated;
    },
    appendMessage: (message, room) => {
      const saved = { ...message, id: `image-${++sequence}` };
      rows.set(key(saved.id, room), saved);
      writes.push({ context: contextKey(), mid: saved.id, patch: saved });
      return saved;
    },
    ensureRecentMessagesLoaded: async () => list(),
  };
  const contextKey = () => JSON.stringify([chatStore.scopeId, sid, archive]);
  const key = (mid, room = sid) => JSON.stringify([chatStore.scopeId, room, archive, mid]);
  const list = () => [...rows.entries()].filter(([k]) => {
    const [scope, room, aid] = JSON.parse(k);
    return scope === chatStore.scopeId && room === sid && aid === archive;
  }).map(([, value]) => value);
  const show = message => {
    if (message.meta?.generatedMedia?.status === 'running') {
      assert.equal(jobs.has(message.id, sid), true, 'first pending render must already own a cancellable job');
    }
    rendered.push(clone(message));
  };
  const jobs = createChatImageJobRuntime({
    getContextKey: contextKey,
    getMessage: chatStore.findMessage,
    updateMessage: chatStore.updateMessage,
    onUpdated: (_mid, message) => show(message),
  });
  const preset = createDefaultImageGenerationPreset();
  preset.paramsByProvider.novelai.promptPrefix = 'watercolor';
  preset.paramsByProvider.novelai.negativePrompt = 'blurry';
  const paramsStore = { ready: Promise.resolve(), getActive: () => preset, list: () => [preset] };
  let config = imageConfig || { provider: 'novelai', model: 'nai-diffusion-4-5-full' };
  const noop = () => {};
  const work = createSessionAsyncWorkRuntime();
  const sandbox = {
    AbortController, console, chatStore, chatImageJobs: jobs, contactsStore: {},
    window: { toastr: Object.fromEntries(['info', 'success', 'warning', 'error'].map(name => [name, text => toasts.push([name, text])])) },
    logger: { warn: noop },
    ensureImageConfigReady: async () => { if (configGate) await configGate.promise; return config; },
    resolveImageReferenceCapability, resolveImageNegativePromptCapability,
    normalizeImageGenerationReferenceItems, getGeneratedImageReferenceItems,
    createImageGenerationReplayRuntime, resolveImageGenerationReplayConfig,
    imageGenerationReferenceStore: createImageGenerationReferenceStore({}),
    imageGenerationParamsStore: paramsStore, mergeImageGenerationRequestOptions,
    imagePromptRuntime: createImagePromptRuntime({ paramsStore }),
    sessionAsyncWorkRuntime: work,
    isChatSendTargetAvailable: () => true,
    resolveMediaSurfaceForSession: () => 'writing',
    getMediaSurfaceCopy: () => ({ pendingText: '正在生成插图', pendingName: '创作插图', successText: '插图生成完成', failedText: '插图生成失败', cancelledText: '插图生成已取消' }),
    resolveImageGenerationSender: ({ sourceMessage }) => ({ role: 'assistant', name: '创作插图', avatar: '', sourceMessageId: sourceMessage?.id || '', hideAvatar: false }),
    isAutoImagePromptOnlyMessage: () => false,
    formatNowTime: () => '12:00',
    resolveGeneratedMediaClusterTailId: (_sid, mid) => mid,
    isSessionActive: () => true,
    renderStoredMessageIfActive: (_mid, message) => show(message),
    ui: { addMessage: show }, autoMarkReadIfActive: noop, refreshChatAndContacts: noop,
    makeAbortError: () => Object.assign(new Error('Aborted'), { name: 'AbortError' }),
    mediaGenerationService: { generateImage: options => {
      const call = { ...deferred(), options };
      calls.push(call);
      return call.promise; // Deliberately ignore abort: verify protection against late provider completions.
    } },
    enqueueAutoImageGeneration: run => run(),
    buildGeneratedImageMessagePatch,
    patchChatImageGenerationMessage: (mid, patch, room) => {
      const updated = chatStore.updateMessage(mid, patch, room);
      if (updated) show(updated);
      return updated;
    },
    getImageGenerationBriefError: error => error?.message || String(error),
    getImageGenerationErrorText: error => error?.message || String(error),
    appendCreativeExecutionImageRetryTask: () => '',
    ensureWorldsForSessionDisplay: async () => { if (worldGate) await worldGate.promise; },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${contextSource}\n${runSource}\n${replaySource}\n${retrySource}\n${loadSource}\n
    globalThis.api = { run: runChatImageGeneration, retry: retryChatGeneratedMediaFailure, load: ensureRecentMessagesAndWorlds,
      repeat: repeatChatImageGeneration,
      async repeatAction(message, sessionId, payload = {}) { const action = 'repeat-image-generation'; ${replayActionSource} },
      cancel(message, sessionId) { const action = 'cancel-media-generation'; ${cancelSource} },
      getError: () => lastChatImageGenerationError };`, sandbox, { filename: 'app-image-job-contract.js' });
  const complete = (index, suffix = index) => {
    const call = calls[index];
    const generationParams = { ...call.options.options };
    call.resolve({ id: `asset-${suffix}`, kind: 'image', status: 'succeeded', prompt: call.options.prompt,
      provider: call.options.config.provider, model: call.options.config.model,
      negativePrompt: call.options.options.negativePrompt, generationParams,
      output: { path: `D:\\images\\result-${suffix}.png`, mime: 'image/png' } });
  };
  return { sid, jobs, work, chatStore, calls, writes, rendered, toasts, preset, config, api: sandbox.api, complete, list,
    put: message => rows.set(key(message.id), message),
    setArchive: value => { archive = value; },
    setConfig: value => { config = value; },
  };
};

{
  const f = fixture({ imageConfig: { provider: 'custom', model: 'reference-fixture' } });
  const references = [{ name: 'character.png', dataUrl: 'data:image/png;base64,cmVmZXJlbmNl' }];
  const originalRun = f.api.run({ prompt: 'garden portrait', referenceImages: references, surface: 'writing' });
  await tick();
  assert.deepEqual(clone(f.calls[0].options.options.referenceImages), references.map(item => item.dataUrl));
  const mid = f.list()[0].id;
  f.calls[0].reject(new Error('fixture image provider failure'));
  assert.equal(await originalRun, false);
  assert.deepEqual(clone(f.chatStore.findMessage(mid).meta.generatedMedia.generationParams.referenceImages), references.map(item => item.dataUrl));
  const retry = f.api.retry({ sessionId: f.sid, messageId: mid });
  await tick();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(Array.from(f.calls[1].options.options.referenceImages || []), references.map(item => item.dataUrl),
    'retrying a failed image must resend the original reference images');
  f.complete(1, 'reference-retry');
  assert.equal(await retry, true);
  assert.equal(f.list().length, 1);
  assert.deepEqual(getGeneratedImageReferenceItems(clone(f.chatStore.findMessage(mid).meta.generatedMedia))
    .map(({ dataUrl, name }) => ({ dataUrl, name })), references);
  console.log('ok - failed image retry resends its original reference images');
}

{
  const config = { provider: 'custom', model: 'reference-fixture' };
  const f = fixture({ imageConfig: config });
  const persisted = JSON.parse(JSON.stringify({ id: 'restored-image', type: 'text', meta: { generatedMedia: {
    kind: 'image', status: 'running', prompt: 'restored portrait', surface: 'writing',
    generationParams: { reference_images: ['data:image/png;base64,YQ==', 'data:image/jpeg;base64,Yg=='] },
  } } }));
  f.put(persisted);
  await f.api.load(f.sid);
  assert.equal(f.chatStore.findMessage(persisted.id).meta.generatedMedia.status, 'interrupted');
  const retry = f.api.retry({ sessionId: f.sid, messageId: persisted.id });
  await tick();
  assert.deepEqual(Array.from(f.calls[0].options.options.referenceImages), persisted.meta.generatedMedia.generationParams.reference_images);
  assert.equal(f.chatStore.findMessage(persisted.id).meta.generatedMedia.referenceImageCount, 2);
  f.calls[0].reject(new Error('fixture failure after restore'));
  assert.equal(await retry, false);
  const failed = clone(f.chatStore.findMessage(persisted.id));
  config.provider = 'novelai';
  config.model = 'nai-diffusion-4-5-full';
  assert.equal(await f.api.retry({ sessionId: f.sid, messageId: persisted.id }), false);
  assert.equal(f.calls.length, 1, 'an incompatible model must not silently submit a text-only retry');
  assert.deepEqual(clone(f.chatStore.findMessage(persisted.id)), failed, 'rejected retry preserves the original references');
  console.log('ok - restored interrupted jobs retain legacy references and incompatible retries preserve the saved job');
}

{
  const f = fixture();
  const originalRun = f.api.run({ prompt: 'garden', negativePrompt: 'watermark', generationParamOverrides: { steps: 31, scale: 7, seed: 123 }, surface: 'writing' });
  await tick();
  assert.equal(f.calls.length, 1);
  const pending = f.list()[0];
  const mid = pending.id;
  const originalParams = clone(pending.meta.generatedMedia.generationParams);
  assert.equal(pending.meta.generatedMedia.prompt, 'garden');
  assert.equal(pending.meta.generatedMedia.negativePrompt, 'watermark');
  assert.equal(originalParams.steps, 31);
  assert.equal(originalParams.seed, '123');
  assert(originalParams.imagePromptDocument, 'the actual prompt document must be frozen before generation');
  assert.deepEqual(clone(f.calls[0].options.options), originalParams);
  assert.equal(f.api.cancel(pending, f.sid), true, 'the actual context-menu action invokes job cancellation');
  assert.equal(f.chatStore.findMessage(mid).meta.generatedMedia.status, 'cancelled');
  assert.equal(f.calls[0].options.signal.aborted, true);
  assert.equal(f.jobs.has(mid, f.sid), false);
  const retry = f.api.retry({ sessionId: f.sid, messageId: mid });
  await tick();
  assert.equal(f.calls.length, 2, 'cancelled image is immediately retryable');
  assert.equal(f.list().length, 1, 'retry replaces the same image message');
  assert.equal(f.chatStore.findMessage(mid).meta.generatedMedia.status, 'running');
  assert.deepEqual(clone(f.calls[1].options.options.imagePromptDocument), originalParams.imagePromptDocument);
  f.complete(0, 'late-old');
  assert.equal(await originalRun, false);
  assert.equal(f.jobs.has(mid, f.sid), true, 'old finally must preserve the retry owner');
  assert.equal(f.chatStore.findMessage(mid).meta.generatedMedia.status, 'running');
  f.complete(1, 'retry');
  assert.equal(await retry, true);
  const completed = f.chatStore.findMessage(mid);
  assert.equal(completed.type, 'image');
  assert.equal(completed.meta.localPath, 'D:\\images\\result-retry.png');
  assert.equal(f.jobs.has(mid, f.sid), false);
  assert.equal(f.work.count(f.sid), 0);
  console.log('ok - actual app cancel/retry wiring preserves prompt snapshots and protects a new job from late success/finally');
}

{
  const f = fixture();
  const oldRun = f.api.run({ prompt: 'forest', surface: 'writing' });
  await tick();
  const mid = f.list()[0].id;
  f.api.cancel(f.chatStore.findMessage(mid), f.sid);
  const retry = f.api.retry({ sessionId: f.sid, messageId: mid });
  await tick();
  f.complete(1, 'finished-new');
  assert.equal(await retry, true);
  const completed = clone(f.chatStore.findMessage(mid));
  const writes = f.writes.length;
  f.calls[0].reject(new Error('late provider failure'));
  assert.equal(await oldRun, false);
  assert.equal(f.writes.length, writes);
  assert.deepEqual(clone(f.chatStore.findMessage(mid)), completed);
  console.log('ok - an old provider failure cannot replace a completed retry with an error');
}

{
  const f = fixture();
  const run = f.api.run({ prompt: 'same id in another scope', surface: 'writing' });
  await tick();
  const mid = f.list()[0].id;
  f.chatStore.scopeId = 'scope-b';
  f.put({ id: mid, type: 'text', content: 'belongs to scope b' });
  const writes = f.writes.length;
  f.complete(0);
  assert.equal(await run, false);
  assert.equal(f.writes.length, writes);
  assert.equal(f.chatStore.findMessage(mid).content, 'belongs to scope b');
  assert.equal(f.work.count(f.sid), 0);
  console.log('ok - app completion guards reject writes after switching storage scope');
}

{
  const gate = deferred();
  const f = fixture({ configGate: gate });
  const run = f.api.run({ prompt: 'must stay in original archive', surface: 'writing' });
  f.setArchive('archive-2');
  gate.resolve();
  assert.equal(await run, false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.writes.length, 0, 'switching archives during configuration loading must not create a pending image');
  assert.equal(f.api.getError(), '目标聊天或存档已变化');
  console.log('ok - preparation captures the original archive before its first await');
}

{
  const orphan = { id: 'orphan', type: 'text', content: '正在生成插图', meta: {
    generatedMedia: { kind: 'image', status: 'running', surface: 'writing', prompt: 'persisted prompt' },
  } };
  const f = fixture();
  f.put(clone(orphan));
  const loaded = await f.api.load(f.sid);
  assert.equal(loaded[0].meta.generatedMedia.status, 'interrupted');
  assert.equal(f.chatStore.findMessage('orphan').meta.generatedMedia.status, 'interrupted');
  const gate = deferred();
  const g = fixture({ worldGate: gate });
  g.put(clone(orphan));
  const loading = g.api.load(g.sid);
  await tick();
  g.setArchive('archive-2');
  g.put({ ...clone(orphan), content: 'other archive' });
  gate.resolve();
  await loading;
  assert.equal(g.writes.length, 0);
  assert.equal(g.chatStore.findMessage('orphan').content, 'other archive');
  console.log('ok - actual session load recovers orphan jobs and skips recovery after an archive change');
}

{
  const f = fixture(); // NovelAI does not accept local reference images in this app.
  assert.equal(await f.api.run({ prompt: 'reused illustration', referenceImages: ['data:image/png;base64,YQ=='], surface: 'writing' }), false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.writes.length, 0, 'a model change cannot silently strip restored references and start a new job');
}
{
  const f = fixture({ imageConfig: { provider: 'openai', model: 'gpt-image-1' } });
  const first = f.api.run({ prompt: 'original scene', referenceImages: [{ dataUrl: 'data:image/png;base64,YQ==', name: 'ref.png' }],
    surface: 'writing', generationParamOverrides: { size: '1024x1024', background: 'transparent', output_format: 'webp' } });
  await tick();
  const original = f.list()[0], originalSnapshot = clone(original);
  const originalOptions = clone(f.calls[0].options.options);
  f.preset.paramsByProvider.openai = { quality: 'high', size: '1536x1024', promptPrefix: 'new prefix', negativePrompt: 'new negative' };
  f.setConfig({ ...f.config, model: 'gpt-image-2' });
  const repeated = f.api.repeatAction(original, f.sid);
  await tick();
  const newMessage = f.list().find(message => message.id !== original.id);
  assert(newMessage, 'repeat immediately creates a separate pending bubble');
  assert.equal(f.jobs.has(original.id, f.sid), true);
  assert.equal(f.jobs.has(newMessage.id, f.sid), true);
  assert.deepEqual(clone(f.chatStore.findMessage(original.id)), originalSnapshot);
  assert.deepEqual(clone(f.calls[1].options.options), originalOptions, 'replay does not inherit changed presets or absent optional parameters');
  assert.equal(f.calls[1].options.config.model, 'gpt-image-1');
  assert.equal(f.calls[0].options.signal.aborted, false);
  f.complete(1); await repeated;
  assert.equal(f.chatStore.findMessage(original.id).meta.generatedMedia.status, 'running');
  f.complete(0); await first;
  assert.equal(f.list().filter(message => message.meta.generatedMedia.status === 'succeeded').length, 2);
  const completedSnapshot = clone(f.chatStore.findMessage(original.id));
  const third = f.api.repeat({ sessionId: f.sid, messageId: original.id });
  await tick();
  assert.deepEqual(clone(f.calls[2].options.options), originalOptions);
  f.complete(2); await third;
  assert.deepEqual(clone(f.chatStore.findMessage(original.id)), completedSnapshot, 'completed source image is not replaced');
  assert.equal(f.list().length, 3);
  f.setConfig({ provider: 'novelai', model: 'nai-diffusion-4-5-full' });
  assert.equal(await f.api.repeat({ sessionId: f.sid, messageId: original.id }), false);
  assert.equal(f.calls.length, 3, 'channel changes cannot silently reinterpret a saved request');
  console.log('ok - actual menu action repeats running and completed images as independent jobs with frozen prompt, model, params and references');
}
console.log('chat-image-job-app-tests passed');
