import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { createMomentsAgentTools } = await import('../../src/scripts/agent/tools/moments-tools.js');
const { saveMaidMomentImages, generateMaidMomentImage, createMaidKeptMomentImages, buildKeptMomentAlbumAssets, MAID_KEPT_MOMENT_IMAGES_KEY } = await import('../../src/scripts/ui/chat/maid-moment-image-assets.js');
const { createMaidMediaAssetTools } = await import('../../src/scripts/agent/tools/media-asset-tools.js');

const publishTool = deps => createMomentsAgentTools(deps).find(tool => tool.name === 'moments.publish');

{
  // 附图动态：用户贴的图（attachmentIds）与现场生图（imagePrompts）都准备好才发布
  const resolved = [];
  const generated = [];
  const published = [];
  const tool = publishTool({
    resolveImage: async ({ attachmentId, context }) => { resolved.push([attachmentId, context.runId]); return { ok: true, dataUrl: `data:image/jpeg;base64,${attachmentId}`, name: `${attachmentId}.jpg`, mime: 'image/jpeg' }; },
    saveMomentImages: async ({ images }) => ({ ok: true, assets: images.map((image, index) => ({ id: `s-${index + 1}`, kind: 'image', prompt: '', output: { path: `saved/${image.name}` } })) }),
    generateMomentImage: async ({ prompt }) => { generated.push(prompt); return { ok: true, asset: { id: `g-${generated.length}`, output: { path: `p/${generated.length}.png` }, prompt } }; },
    publishMoment: async (payload) => { published.push(payload); return { ok: true, momentId: 'm1', commentsRequested: true }; },
  });
  assert.ok(tool.schema.properties.attachmentIds && tool.schema.properties.imagePrompts, 'schema exposes both image sources');
  const result = await tool.execute({ content: '周六演出加油！', attachmentIds: ['1', 'img-a', '1'], imagePrompts: ['live house poster'] }, { runId: 'run-1' });
  assert.equal(result.ok, true);
  assert.deepEqual(resolved, [['1', 'run-1'], ['img-a', 'run-1']], 'attachments resolved once each with the maid context');
  assert.deepEqual(generated, ['live house poster']);
  assert.deepEqual(published[0].assets.map(asset => asset.output.path), ['saved/1.jpg', 'saved/img-a.jpg', 'p/1.png']);
  assert.equal(result.imageCount, 3);
  assert.match(tool.summarizeResult(result), /moment published id=m1.*3 image/);
  console.log('ok - moments.publish attaches user images and freshly generated images');
}

{
  // 任一张图拿不到就不发布；张数有上限；未接通道明确报错
  let published = 0;
  const base = { publishMoment: async () => { published += 1; return { ok: true, momentId: 'x' }; } };
  const missing = await publishTool({ ...base, saveMomentImages: async () => ({ ok: true, assets: [] }), resolveImage: async () => ({ ok: false, reason: 'image_attachment_missing', message: '没有找到本次请求中的图片附件。' }) })
    .execute({ content: 'x', attachmentIds: ['9'] }, {});
  assert.deepEqual([missing.ok, missing.reason, published], [false, 'image_attachment_missing', 0]);
  const failedGen = await publishTool({ ...base, generateMomentImage: async () => ({ ok: false, reason: 'image_config_unavailable', message: '图片配置不可用' }) })
    .execute({ content: 'x', imagePrompts: ['a'] }, {});
  assert.deepEqual([failedGen.ok, failedGen.reason, published], [false, 'image_config_unavailable', 0]);
  const tooMany = await publishTool({ ...base, resolveImage: async () => ({ ok: true, dataUrl: 'data:image/png;base64,x' }), generateMomentImage: async () => ({ ok: true, asset: { output: { path: 'p' } } }) })
    .execute({ content: 'x', attachmentIds: ['1', '2', '3', '4', '5', '6', '7'], imagePrompts: ['a', 'b', 'c'] }, {});
  assert.deepEqual([tooMany.ok, tooMany.reason, published], [false, 'moment_images_too_many', 0]);
  // 存不下贴来的图：在开始画之前就停，不花生图的钱
  let drawnAfterSaveFailure = 0;
  const unsaved = await publishTool({
    ...base,
    resolveImage: async () => ({ ok: true, dataUrl: 'data:image/png;base64,x' }),
    saveMomentImages: async () => ({ ok: false, reason: 'moment_image_save_failed', message: '动态配图保存失败。' }),
    generateMomentImage: async () => { drawnAfterSaveFailure += 1; return { ok: true, asset: { id: 'g', output: { path: 'p' } } }; },
  }).execute({ content: 'x', attachmentIds: ['1'], imagePrompts: ['a'] }, {});
  assert.deepEqual([unsaved.ok, unsaved.reason, drawnAfterSaveFailure, published], [false, 'moment_image_save_failed', 0, 0]);
  const noChannel = await publishTool(base).execute({ content: 'x', attachmentIds: ['1'] }, {});
  assert.equal(noChannel.reason, 'moment_images_unavailable');
  const textOnly = await publishTool(base).execute({ content: '只有文字' }, {});
  assert.equal(textOnly.ok, true, 'text-only posts work as before');
  console.log('ok - moments.publish refuses to post when an image is missing or over the limit');
}

{
  // 存成动态附件（走手动发图同一种 asset）；生图用当前图片配置与参数预设
  const saved = [];
  const ok = await saveMaidMomentImages({
    images: [{ dataUrl: 'data:image/jpeg;base64,AA', name: 'a.jpg', mime: 'image/jpeg' }, { dataUrl: 'data:image/png;base64,BB', mime: 'image/png' }],
    saveAttachment: async ({ sessionId, dataUrl, fileName }) => { saved.push([sessionId, fileName]); return { path: `${sessionId}/${fileName}` }; },
    sessionId: 'moments_generated_images',
    idPrefix: 'maid-moment-1',
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.assets.map(asset => [asset.id, asset.kind, asset.output.path, asset.output.mime]), [
    ['maid-moment-1-1', 'image', 'moments_generated_images/a.jpg', 'image/jpeg'],
    ['maid-moment-1-2', 'image', 'moments_generated_images/maid-moment-1-2.png', 'image/png'],
  ]);
  const broken = await saveMaidMomentImages({ images: [{ dataUrl: 'data:image/png;base64,x' }], saveAttachment: async () => ({}), sessionId: 's', idPrefix: 'p' });
  assert.deepEqual([broken.ok, broken.reason], [false, 'moment_image_save_failed']);

  const calls = [];
  const gen = await generateMaidMomentImage({
    prompt: ' poster ',
    loadConfig: async () => ({ provider: 'novelai' }),
    canUseConfig: config => Boolean(config?.provider),
    loadPreset: async () => ({ id: 'default' }),
    mergeOptions: ({ config, preset }) => ({ from: [config.provider, preset.id] }),
    generateImage: async (request) => { calls.push(request); return { id: 'g1', output: { path: 'x.png' } }; },
    sessionId: 'moments_generated_images',
    scope: { surface: 'moments', targetId: 'default' },
  });
  assert.equal(gen.ok, true);
  assert.equal(calls[0].prompt, 'poster');
  assert.deepEqual(calls[0].options, { from: ['novelai', 'default'] });
  assert.equal(calls[0].sessionId, 'moments_generated_images');
  const noConfig = await generateMaidMomentImage({ prompt: 'x', loadConfig: async () => null, canUseConfig: () => false });
  assert.deepEqual([noConfig.ok, noConfig.reason], [false, 'image_config_unavailable']);
  console.log('ok - maid moment images are saved like composer images and generated with the active image config');
}

{
  // 取图沿用头像／壁纸同一套附件池：用户贴的图（按序号或 id）、本次生成过的图；发动态不做头像/壁纸用途核对
  let resolver = null;
  const tools = createMaidMediaAssetTools({
    prepareImage: async ({ dataUrl }) => ({ dataUrl: `${dataUrl}#prepared`, mime: 'image/jpeg', width: 10, height: 10 }),
    onImageResolverReady: api => { resolver = api; },
  });
  assert.ok(tools.length && typeof resolver?.resolveImageForMoment === 'function');
  const context = { maidAttachments: [{ id: 'u1', name: 'cat.png', type: 'image/png', url: 'data:image/png;base64,CAT' }] };
  const byIndex = await resolver.resolveImageForMoment({ attachmentId: '1', context });
  assert.equal(byIndex.dataUrl, 'data:image/png;base64,CAT#prepared');
  const missing = await resolver.resolveImageForMoment({ attachmentId: 'nope', context });
  assert.equal(missing.ok, false);
  console.log('ok - moment images resolve through the same maid attachment pool');
}

{
  // app.js 接线：发布带上 assets；工具拿到取图与生图通道；功能目录写明可附图
  const appSource = await readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /publishMoment: async \(\{ content = '', generateComments = true, assets = \[\] \} = \{\}\)/);
  assert.match(appSource, /resolveImage: args => maidMomentImageResolver\?\.resolveImageForMoment\?\.\(args\)/);
  assert.match(appSource, /generateMomentImage: async \(\{ prompt = '', signal = null \} = \{\}\) => generateMaidMomentImage\(\{/);
  const catalogSource = await readFile(new URL('../../src/scripts/agent/app-feature-catalog.js', import.meta.url), 'utf8');
  assert.match(catalogSource, /attachmentIds[^']*imagePrompts|imagePrompts[^']*attachmentIds/);
  console.log('ok - the app wires maid moment images into the existing publish path');
}

const { createMaidToolConfirmationRuntime } = await import('../../src/scripts/ui/maid-tool-confirmation-runtime.js');
const { createMaidAssistantAgent } = await import('../../src/scripts/agent/maid-assistant-agent.js');
const { buildMaidResultBasis } = await import('../../src/scripts/agent/maid-result-basis.js');
const { MaidConversationStore } = await import('../../src/scripts/storage/maid-conversation-store.js');

// 第 failAt 张失败的场景；decision 是用户在确认框里的选择
const partialScene = ({ failAt = 2, decision = { decision: 'allow' }, deps = {}, context = {} } = {}) => {
  const drawn = [], published = [], asked = [], kept = [];
  const tool = publishTool({
    keepMomentImages: async (args) => { kept.push(args); },
    generateMomentImage: async ({ prompt }) => {
      drawn.push(prompt);
      return drawn.length === failAt
        ? { ok: false, reason: 'moment_image_generation_failed', message: '配图生成失败：额度不足' }
        : { ok: true, asset: { id: `g-${drawn.length}`, kind: 'image', prompt, output: { path: `native/p${drawn.length}.png`, mime: 'image/png' } } };
    },
    publishMoment: async (payload) => { published.push(payload); return { ok: true, momentId: 'm1', commentsRequested: true }; },
    ...deps,
  });
  return {
    tool, drawn, published, asked, kept,
    context: {
      roleCardId: 'card', runId: 'run',
      requestToolConfirmation: async (request, options) => { asked.push({ request, options }); return decision; },
      ...context,
    },
  };
};

{
  // 第 2 张失败：程序停下来问用户，不再画第 3 张（省钱），用户选发就只发已生成的
  const scene = partialScene();
  const signal = new AbortController().signal;
  const result = await scene.tool.execute({ content: '周末', imagePrompts: ['a', 'b', 'c'] }, { ...scene.context, signal });
  assert.deepEqual(scene.drawn, ['a', 'b'], 'stops drawing at the first failure');
  assert.equal(scene.asked.length, 1, 'the program asks; the model does not decide');
  const { request, options } = scene.asked[0];
  assert.equal(request.allowAlways, false, 'never skipped by an always-allow rule');
  assert.equal(request.toolName, 'moments.publish');
  assert.equal(request.confirmText, '发已生成的 1 张');
  assert.equal(request.cancelText, '先不发');
  assert.match(request.message, /第 2 张/);
  assert.match(request.message, /额度不足/);
  assert.match(request.message, /已生成 1 张/);
  assert.match(request.message, /还有 1 张没开始画/);
  assert.equal(options.signal, signal, 'cancelling the task closes the question');
  assert.equal(options.runId, 'run');
  assert.deepEqual(scene.published[0].assets.map(asset => asset.id), ['g-1']);
  assert.equal(result.ok, true);
  assert.equal(result.imageCount, 1);
  assert.equal(result.missingImageCount, 2, 'the maid knows the post is short of images');
  assert.match(result.message, /少了 2 张/);
  console.log('ok - a failed image stops drawing and asks the user; publishing keeps only what exists');
}

let declined, declinedTool;
{
  // 选「先不发」：不发布；已生成的留着，结束本轮并直接告诉用户
  const scene = partialScene({ decision: { decision: 'deny' } });
  declined = await scene.tool.execute({ content: '周末', imagePrompts: ['a', 'b', 'c'] }, scene.context);
  declinedTool = scene.tool;
  assert.equal(scene.published.length, 0);
  assert.equal(declined.ok, false);
  assert.equal(declined.cancelled, true);
  assert.deepEqual(declined.keptImages, [{ attachmentId: 'g-1', prompt: 'a' }]);
  assert.deepEqual(declined.remainingPrompts, ['b', 'c']);
  assert.equal(declined.content, '周末');
  assert.deepEqual(scene.kept[0].assets.map(asset => asset.output.path), ['native/p1.png'], 'the full asset is kept locally');
  assert.equal(scene.kept[0].roleCardId, 'card');
  assert.ok(!JSON.stringify(declined).includes('native/'), 'file paths never enter the tool result the model reads');
  assert.match(declined.message, /没有发布/);
  assert.match(declined.message, /已保留 1 张/);
  assert.equal(scene.tool.summarizeResult(declined), declined.message, 'the user reads the message, not a technical code');
  console.log('ok - declining keeps the generated images and publishes nothing');
}

{
  // 一张都没有：按钮换成「只发文字」；用户选了才发纯文字
  const scene = partialScene({ failAt: 1 });
  const result = await scene.tool.execute({ content: '只有字', imagePrompts: ['a', 'b'] }, scene.context);
  assert.equal(scene.asked[0].request.confirmText, '只发文字');
  assert.deepEqual(scene.drawn, ['a']);
  assert.equal(scene.published[0].assets, undefined);
  assert.equal(result.ok, true);
  assert.equal(result.imageCount, 0);
  const none = partialScene({ failAt: 1, decision: { decision: 'deny' } });
  const noneResult = await none.tool.execute({ content: '只有字', imagePrompts: ['a'] }, none.context);
  assert.equal(noneResult.keptImages, undefined);
  assert.equal(none.kept.length, 0, 'nothing to keep');
  assert.match(noneResult.message, /没有发布/);
  console.log('ok - when every image fails the choice becomes text only or not now');
}

{
  // 用户贴的图 + 现场生图：按钮按实际张数；选「先不发」时贴的图也存下来，下一轮还能用
  const saved = [];
  const scene = partialScene({
    decision: { decision: 'deny' },
    deps: {
      resolveImage: async ({ attachmentId }) => ({ ok: true, dataUrl: `data:image/png;base64,${attachmentId}`, name: `${attachmentId}.png`, mime: 'image/png' }),
      saveMomentImages: async ({ images }) => { saved.push(...images); return { ok: true, assets: images.map((image, index) => ({ id: `pasted-${index + 1}`, kind: 'image', prompt: '', output: { path: `native/${image.name}`, mime: image.mime } })) }; },
    },
  });
  const result = await scene.tool.execute({ content: '混合', attachmentIds: ['u1'], imagePrompts: ['a', 'b'] }, scene.context);
  assert.equal(scene.asked[0].request.confirmText, '发已有的 2 张');
  assert.deepEqual(saved.map(image => image.name), ['u1.png']);
  assert.deepEqual(result.keptImages.map(image => image.attachmentId), ['pasted-1', 'g-1']);
  assert.deepEqual(scene.kept[0].assets.map(asset => asset.id), ['pasted-1', 'g-1']);
  console.log('ok - pasted images survive a declined post too');
}

{
  // 当前环境没有确认通道：绝不替用户发，把留下的图交给女仆，由她转告
  const scene = partialScene({ context: { requestToolConfirmation: undefined } });
  const result = await scene.tool.execute({ content: 'x', imagePrompts: ['a', 'b'] }, scene.context);
  assert.equal(scene.published.length, 0);
  assert.equal(result.ok, false);
  assert.notEqual(result.cancelled, true);
  assert.equal(result.reason, 'moment_image_generation_failed');
  assert.deepEqual(result.keptImages, [{ attachmentId: 'g-1', prompt: 'a' }]);
  assert.deepEqual(result.remainingPrompts, ['b']);

  // 用户中止任务：不再弹问题，已生成的同样留着
  const controller = new AbortController();
  const aborted = partialScene({
    context: { signal: controller.signal },
    deps: { generateMomentImage: async ({ prompt }) => {
      if (prompt === 'b') { controller.abort(); return { ok: false, reason: 'moment_image_generation_failed', message: '配图生成失败：aborted' }; }
      return { ok: true, asset: { id: 'g-1', prompt, output: { path: 'native/p1.png' } } };
    } },
  });
  const abortedResult = await aborted.tool.execute({ content: 'x', imagePrompts: ['a', 'b'] }, aborted.context);
  assert.equal(aborted.asked.length, 0);
  assert.equal(aborted.published.length, 0);
  assert.equal(abortedResult.cancelled, true);
  assert.equal(abortedResult.reason, 'user_aborted');
  assert.deepEqual(abortedResult.keptImages.map(image => image.attachmentId), ['g-1']);

  // 图都好了但发布失败：同样留着，重试不用再画
  const brokenPublish = partialScene({ failAt: 0, deps: { publishMoment: async () => ({ ok: false, reason: 'persist_failed', message: '动态发布失败：未能建立动态记录。' }) } });
  const brokenResult = await brokenPublish.tool.execute({ content: 'x', imagePrompts: ['a'] }, brokenPublish.context);
  assert.equal(brokenResult.ok, false);
  assert.equal(brokenResult.reason, 'persist_failed');
  assert.equal(brokenPublish.asked.length, 0);
  assert.deepEqual(brokenResult.keptImages.map(image => image.attachmentId), ['g-1']);
  console.log('ok - no confirmation channel, an aborted task and a failed publish all keep the images');
}

{
  // 确认框：不吃「始终允许」，两个按钮都用这里写的文字
  const shown = [];
  const runtime = createMaidToolConfirmationRuntime({
    allowStore: { isAllowed: () => true, allowAlways: () => { throw new Error('must not remember'); } },
    choose: async (options) => { shown.push(options); return 'allow_once'; },
  });
  const scene = partialScene({ context: { requestToolConfirmation: (request, options) => runtime.request(request, options) } });
  const result = await scene.tool.execute({ content: 'x', imagePrompts: ['a', 'b'] }, scene.context);
  assert.equal(shown.length, 1, 'an always-allow rule for this tool must not skip the question');
  assert.deepEqual(shown[0].actions.map(action => action.label), ['先不发', '发已生成的 1 张']);
  assert.equal(result.ok, true);
  console.log('ok - the real confirmation runtime shows the two choices and ignores always-allow');
}

{
  // 下一轮：按 id 取回留下的图（重启后也在），完整资讯不丢；限本卡，文件没了就算没有，有上限
  const data = new Map();
  let available = true;
  const makeStore = () => createMaidKeptMomentImages({
    loadKv: async key => data.get(key),
    saveKv: async (key, value) => { data.set(key, structuredClone(value)); },
    canReadFile: async () => { if (!available) throw new Error('removed'); return true; },
  });
  const longPrompt = 'p'.repeat(1500);
  const asset = { id: 'g-1', kind: 'image', provider: 'novelai', prompt: longPrompt, generationParams: { nested: { steps: { value: 28 } } }, output: { path: 'native/p1.png', mime: 'image/png' } };
  await makeStore().keep({ assets: [asset], roleCardId: 'card' });
  assert.ok(data.has(MAID_KEPT_MOMENT_IMAGES_KEY));
  const restarted = makeStore();
  const kept = await restarted.load({ attachmentId: 'g-1', roleCardId: 'card' });
  assert.deepEqual(kept, asset, 'the same asset comes back after a restart, nothing truncated');
  assert.equal(await restarted.load({ attachmentId: 'g-1', roleCardId: 'other' }), null, 'another card cannot use it');
  assert.equal(await restarted.load({ attachmentId: 'nope', roleCardId: 'card' }), null);
  available = false;
  assert.equal(await restarted.load({ attachmentId: 'g-1', roleCardId: 'card' }), null, 'a removed file is not usable');
  available = true;

  // 再发一次：只补画失败的那张，留下的不重画
  const drawn = [], published = [];
  const retry = publishTool({
    resolveImage: async () => { throw new Error('kept images must not go through the re-encoding path'); },
    saveMomentImages: async () => { throw new Error('kept images must not be saved again'); },
    loadKeptMomentImage: async ({ attachmentId, roleCardId }) => (attachmentId === 'g-1' && roleCardId === 'card' ? kept : null),
    generateMomentImage: async ({ prompt }) => { drawn.push(prompt); return { ok: true, asset: { id: 'g-2', prompt, output: { path: 'native/p2.png' } } }; },
    publishMoment: async (payload) => { published.push(payload); return { ok: true, momentId: 'm2' }; },
  });
  const result = await retry.execute({ content: '周末', attachmentIds: ['g-1'], imagePrompts: ['b'] }, { roleCardId: 'card' });
  assert.equal(result.ok, true);
  assert.deepEqual(drawn, ['b'], 'only the missing image is drawn');
  assert.deepEqual(published[0].assets.map(asset => asset.id), ['g-1', 'g-2']);

  // 顺序照她传的来：留下的图排在贴来的图前面也不会被打乱
  const orderedPublished = [];
  const ordered = publishTool({
    resolveImage: async ({ attachmentId }) => ({ ok: true, dataUrl: `data:image/png;base64,${attachmentId}`, name: `${attachmentId}.png` }),
    saveMomentImages: async ({ images }) => ({ ok: true, assets: images.map(image => ({ id: `saved-${image.name}`, output: { path: image.name } })) }),
    loadKeptMomentImage: async ({ attachmentId }) => (attachmentId === 'g-1' ? kept : null),
    publishMoment: async (payload) => { orderedPublished.push(payload); return { ok: true, momentId: 'm3' }; },
  });
  await ordered.execute({ content: 'x', attachmentIds: ['u1', 'g-1', 'u2'] }, { roleCardId: 'card' });
  assert.deepEqual(orderedPublished[0].assets.map(asset => asset.id), ['saved-u1.png', 'g-1', 'saved-u2.png']);
  assert.match(retry.schema.properties.attachmentIds.description, /keptImages/);
  console.log('ok - kept images are reusable by id, stay card scoped, and are not redrawn');
}

{
  // 这一轮到此结束，用户直接看到说明；下一轮女仆从历史知道留了什么、还差什么，文件路径不进模型
  let plannerCalls = 0;
  const output = { toolName: 'moments.publish', status: 'succeeded', result: declined, summary: declinedTool.summarizeResult(declined) };
  const agent = createMaidAssistantAgent({
    logger: {},
    planner: async () => ({ ok: true, toolName: 'moments.publish', featureId: 'moments.publish', args: { content: '周末', imagePrompts: ['a', 'b', 'c'] } }),
    toolRegistry: { executeTool: async () => output },
    reactPlanner: async () => { plannerCalls += 1; return { ok: true, action: 'final', message: 'done' }; },
  });
  const reply = await agent.runPrompt('发个动态配三张图', { roleCardId: 'card', uiMode: 'chat' });
  assert.equal(reply.status, 'cancelled');
  assert.equal(reply.message, declined.message);
  assert.equal(plannerCalls, 0, 'the model does not get to retry after the user said not now');

  const basis = buildMaidResultBasis(reply);
  assert.deepEqual(basis.artifacts, [{ attachmentId: 'g-1', subject: 'a', purpose: 'moment' }]);
  assert.deepEqual(basis.pendingMoment, { content: '周末', remainingPrompts: ['b', 'c'] });
  assert.ok(!JSON.stringify(basis).includes('native/'), 'file paths stay out of the result basis');
  assert.equal(buildMaidResultBasis({ steps: [{ toolName: 'moments.publish', status: 'succeeded', output: { ok: true, momentId: 'm1' } }] }).pendingMoment, undefined);

  const data = new Map();
  const options = { storage: null, loadKv: async key => data.get(key), saveKv: async (key, value) => data.set(key, structuredClone(value)), compactionTurnThreshold: 1000, compactionHistoryTokenThreshold: 100000 };
  const store = new MaidConversationStore(options); await store.load();
  await store.appendTurn({ input: '发个动态配三张图', status: reply.status, message: reply.message, resultBasis: basis });
  const reloaded = new MaidConversationStore(options); await reloaded.load();
  const history = reloaded.getHistoryContextText();
  assert.ok(history.includes('g-1') && history.includes('pendingMoment') && history.includes('周末'), history);
  assert.ok(!history.includes('native/'));
  assert.deepEqual(reloaded.getContextSnapshot().pendingMoment, { content: '周末', remainingPrompts: ['b', 'c'] }, 'routing can see the unpublished moment');
  await reloaded.appendTurn({ input: '第二张重画一下', status: 'succeeded', message: '画好了', resultBasis: buildMaidResultBasis({ steps: [{ toolName: 'media.generate_image', status: 'succeeded', output: { ok: true, attachmentId: 'generated-1' } }] }) });
  assert.ok(reloaded.getContextSnapshot().pendingMoment, 'another tool in between does not settle it');
  await reloaded.appendTurn({ input: '发吧', status: 'succeeded', message: '发了', resultBasis: buildMaidResultBasis({ steps: [{ toolName: 'moments.publish', status: 'succeeded', output: { ok: true, momentId: 'm1' } }] }) });
  assert.equal(reloaded.getContextSnapshot().pendingMoment, null, 'publishing settles it');

  // 没有确认通道时女仆会继续：她看得到 id 与提示词
  const { cancelled, ...keptButContinues } = declined;
  const continued = { ...keptButContinues, reason: 'moment_image_generation_failed' };
  let observed = null;
  const continuing = createMaidAssistantAgent({
    logger: {},
    planner: async () => ({ ok: true, toolName: 'moments.publish', featureId: 'moments.publish', args: { content: '周末' } }),
    toolRegistry: { executeTool: async () => ({ toolName: 'moments.publish', status: 'succeeded', result: continued }) },
    reactPlanner: async (_input, planContext) => { observed = planContext; return { ok: true, action: 'final', message: '告诉用户' }; },
  });
  await continuing.runPrompt('发个动态', { roleCardId: 'card', uiMode: 'chat' });
  assert.deepEqual(observed.maidReactSteps[0].output.keptImages, [{ attachmentId: 'g-1', prompt: 'a' }]);
  console.log('ok - the run stops with a readable message and the next turn knows what was kept');
}

{
  const appSource = await readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /saveMomentImages: \(\{ images = \[\] \} = \{\}\) =>/);
  assert.match(appSource, /keepMomentImages: args => maidKeptMomentImages\.keep\(args\)/);
  assert.match(appSource, /loadKeptMomentImage: args => maidKeptMomentImages\.load\(args\)/);
  const plannerSource = await readFile(new URL('../../src/scripts/agent/maid-model-planner.js', import.meta.url), 'utf8');
  assert.match(plannerSource, /resultBasis\.pendingMoment/);
  console.log('ok - the app wires kept moment images and documents them for the planner');
}

{
  // 动态相册：留下的图按卡列出、最新在前；能移除；数量再多也不会悄悄掉记录（掉了就再也找不到那张图）
  const data = new Map();
  const makeStore = () => createMaidKeptMomentImages({
    loadKv: async key => data.get(key),
    saveKv: async (key, value) => { data.set(key, structuredClone(value)); },
  });
  const store = makeStore();
  await store.keep({ assets: [{ id: 'a', output: { path: 'a' } }, { id: 'b', output: { path: 'b' } }], roleCardId: 'card' });
  await store.keep({ assets: [{ id: 'c', output: { path: 'c' } }], roleCardId: 'other' });
  await store.keep({ assets: [{ id: 'a', output: { path: 'a' } }], roleCardId: 'card' });
  assert.deepEqual(store.list({ roleCardId: 'card' }).map(asset => asset.id), ['a', 'b'], 'newest first, no duplicates');
  assert.deepEqual(store.list({ roleCardId: 'other' }).map(asset => asset.id), ['c']);
  const restarted = makeStore();
  await restarted.ready;
  assert.deepEqual(restarted.list({ roleCardId: 'card' }).map(asset => asset.id), ['a', 'b'], 'the album can list them right after boot');
  await restarted.remove({ ids: ['a', 'not-kept'] });
  assert.deepEqual(restarted.list({ roleCardId: 'card' }).map(asset => asset.id), ['b']);
  assert.equal(await restarted.load({ attachmentId: 'a', roleCardId: 'card' }), null, 'a removed image can no longer be reused');
  const reloaded = makeStore();
  await reloaded.ready;
  assert.deepEqual(reloaded.list({ roleCardId: 'card' }).map(asset => asset.id), ['b'], 'removal is saved');
  await reloaded.keep({ assets: Array.from({ length: 80 }, (_, index) => ({ id: `n-${index}`, output: { path: `n-${index}` } })), roleCardId: 'card' });
  assert.equal(reloaded.list({ roleCardId: 'card' }).length, 81, 'nothing is silently dropped');
  assert.equal(makeStore().list({ roleCardId: 'card' }).length, 0, 'listing before the first read is empty, not an error');

  // 相册卡片：标「未发布」，按钮是「发布动态」；没有提示词（用户贴的图）也能发
  const [albumAsset] = buildKeptMomentAlbumAssets([{ id: 'pasted', prompt: '', output: { path: 'p' } }]);
  assert.equal(albumAsset.albumId, 'kept::pasted');
  assert.equal(albumAsset.keptMomentImage, true);
  assert.equal(albumAsset.albumBadge, '未发布');
  assert.equal(albumAsset.albumUseText, '发布动态');
  assert.equal(albumAsset.output.path, 'p');
  console.log('ok - kept images can be listed per card, removed, and are never silently dropped');
}

{
  // 相册按钮：普通图沿用「使用」（没有提示词就不能用）；留下的图按自己的文字，一律可用
  const { resolveGeneratedImageAlbumUseAction } = await import('../../src/scripts/ui/generated-image-album-panel.js');
  assert.deepEqual(resolveGeneratedImageAlbumUseAction({ prompt: 'x' }), { text: '使用', enabled: true });
  assert.deepEqual(resolveGeneratedImageAlbumUseAction({ prompt: '' }), { text: '使用', enabled: false });
  assert.deepEqual(resolveGeneratedImageAlbumUseAction({ prompt: '', albumUseText: '发布动态' }), { text: '发布动态', enabled: true });
  console.log('ok - the album button follows the kind of image');
}

{
  // app.js 接线：相册列出留下的图；发布直接带图进草稿（不重画）；发出去或删除后从「未发布」消失
  const appSource = await readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /collect: \(\) => \[\s*\.\.\.buildKeptMomentAlbumAssets\(maidKeptMomentImages\.list\(/);
  assert.match(appSource, /asset\.keptMomentImage\s*\?\s*openMomentComposeModal\(\{ initialAssets: \[asset\] \}\)/);
  assert.match(appSource, /asset\.keptMomentImage \? deleteKeptMomentImage\(asset\) : deleteGeneratedImageAssetFromMoments\(asset\)/);
  assert.equal(appSource.match(/maidKeptMomentImages\.remove\(\{ ids: /g)?.length, 3, 'removed after a maid post, a manual post and a delete');
  assert.match(appSource, /assets = Array\.isArray\(initialAssets\) \? \[\.\.\.initialAssets\] : \[\];/);
  assert.match(appSource, /bodyEl\.insertBefore\(previewEl, assets\.length \? overlay\.querySelector\('\.moment-image-prompt-editor'\) : statusEl\)/, 'a carried image shows right under the text');
  const panelSource = await readFile(new URL('../../src/scripts/ui/generated-image-album-panel.js', import.meta.url), 'utf8');
  assert.match(panelSource, /albumBadge/);
  console.log('ok - the album offers kept images and removes them once posted or deleted');
}

console.log('maid-moment-image-assets-tests passed');
