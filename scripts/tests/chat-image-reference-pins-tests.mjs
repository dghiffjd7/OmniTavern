import assert from 'node:assert/strict';

const { createChatImageReferencePins, mergeChatReferenceImages, CHAT_IMAGE_REFERENCE_PIN_LIMIT } = await import('../../src/scripts/ui/chat/chat-image-reference-pins.js');
const { collectStoredImageReferences } = await import('../../src/scripts/ui/image-generation-reference-store.js');

// 假的参考图存储：persist 按内容给路径（同内容同路径），load 读不到 missing 的那张
const createReferenceStore = ({ missing = new Set() } = {}) => {
  const files = new Map();
  return {
    files,
    persist: async (items, sessionId) => items.map((item) => {
      const hash = `h-${item.dataUrl.length}-${item.dataUrl.slice(-4)}`;
      const path = `${sessionId}/ref_${hash}.png`;
      files.set(path, item.dataUrl);
      return { path, sessionId, hash, mime: 'image/png', bytes: 3, name: item.name || '' };
    }),
    load: async (items) => items.map((item) => {
      if (missing.has(item.path) || !files.has(item.path)) throw new Error(`参考图读取失败`);
      return { dataUrl: files.get(item.path), name: item.name, mime: item.mime };
    }),
  };
};

{
  // 固定：存成会话附件记进会话；同一张不重复；有上限；取消固定；读不到的跳过
  const sessions = { s1: {} };
  let saves = 0;
  const store = createReferenceStore();
  const pins = createChatImageReferencePins({ getSession: id => sessions[id] || null, saveSessions: () => { saves += 1; }, referenceStore: store, logger: { warn() {} } });
  const first = await pins.pin('s1', { dataUrl: 'data:image/png;base64,AAAA', name: '三视图' });
  assert.deepEqual([first.ok, first.item.name, saves], [true, '三视图', 1]);
  // 对话框用 item.key 记住刚固定的图、之后拿它取消固定：pin 的结果要带 key（与 load 的 key 相同）
  assert.equal(first.item.key, first.item.path);
  assert.deepEqual(sessions.s1.pinnedImageReferences.map(item => item.path), [first.item.path]);
  const again = await pins.pin('s1', { dataUrl: 'data:image/png;base64,AAAA' });
  assert.deepEqual([again.ok, again.duplicate, pins.list('s1').length, saves], [true, true, 1, 1], 'the same image is not pinned twice');
  assert.equal(again.item.key, first.item.path, 'a duplicate pin returns the existing key');
  // 刚固定的图用 pin 给的 key 取消固定
  const fresh = await pins.pin('s1', { dataUrl: 'data:image/png;base64,EEEE' });
  assert.equal(pins.unpin('s1', fresh.item.key), true);
  assert.equal(pins.list('s1').length, 1);
  assert.equal((await pins.pin('nope', { dataUrl: 'data:image/png;base64,BBBB' })).reason, 'no_session');

  const second = await pins.pin('s1', { dataUrl: 'data:image/png;base64,CCCC', name: '服装' });
  const loaded = await pins.load('s1');
  assert.deepEqual(loaded.items.map(item => [item.key, item.dataUrl, item.name]), [[first.item.path, 'data:image/png;base64,AAAA', '三视图'], [second.item.path, 'data:image/png;base64,CCCC', '服装']]);
  assert.equal((await pins.load('s1', { max: 1 })).items.length, 1);

  store.files.delete(first.item.path);
  const partial = await pins.load('s1');
  assert.deepEqual([partial.items.map(item => item.name), partial.missing], [['服装'], [first.item.path]], 'a missing file is skipped, not fatal');

  assert.equal(pins.unpin('s1', first.item.path), true);
  assert.equal(pins.unpin('s1', first.item.path), false);
  assert.deepEqual(pins.list('s1').map(item => item.name), ['服装']);

  for (let i = pins.list('s1').length; i < CHAT_IMAGE_REFERENCE_PIN_LIMIT; i += 1) await pins.pin('s1', { dataUrl: `data:image/png;base64,D${String(i).padStart(3, '0')}` });
  assert.equal((await pins.pin('s1', { dataUrl: 'data:image/png;base64,ZZZZ' })).reason, 'limit');
  console.log('ok - chat reference pins persist, dedupe, cap, unpin and skip missing files');
}

{
  // 会话在存档期间被换掉：不写进新的会话物件
  const sessions = { s1: {} };
  const store = createReferenceStore();
  const slow = { ...store, persist: async (items, sid) => { sessions.s1 = {}; return store.persist(items, sid); } };
  const pins = createChatImageReferencePins({ getSession: id => sessions[id] || null, referenceStore: slow });
  assert.equal((await pins.pin('s1', { dataUrl: 'data:image/png;base64,AAAA' })).reason, 'no_session');
  assert.equal(sessions.s1.pinnedImageReferences, undefined);
  console.log('ok - a pin finishing after the session was replaced is dropped');
}

{
  // 合并：本聊天参考图在前、本次参考图在后，去重，不超过上限
  const pinned = [{ dataUrl: 'data:a', name: '三视图' }, { dataUrl: 'data:b', name: '服装' }];
  const manual = [{ dataUrl: 'data:b' }, { dataUrl: 'data:c', name: '姿势' }];
  assert.deepEqual(mergeChatReferenceImages(pinned, manual, 16).map(item => item.dataUrl), ['data:a', 'data:b', 'data:c']);
  assert.deepEqual(mergeChatReferenceImages(pinned, manual, 2).map(item => item.name), ['三视图', '服装'], 'pinned images win when the model limit is small');
  assert.deepEqual(mergeChatReferenceImages([], manual, 0), []);

  // 找重复文件时也认得固定的参考图
  const stored = collectStoredImageReferences({ pinned: [{ path: 'p1', hash: 'h1' }, { name: 'no path' }], messages: [], assets: [] });
  assert.deepEqual(stored.map(item => item.path), ['p1']);
  console.log('ok - pinned references come first, are de-duplicated and capped');
}

{
  // NAI 精准参考：参数打开才算支持参考图（最多 1 张）；V4 以下不支持；请求照官方字段，保真度反过来传
  globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
  const { resolveImageReferenceCapability } = await import('../../src/scripts/ui/media-generation-service.js');
  const { NovelAIImageProvider, pickNovelAIReferenceSize } = await import('../../src/scripts/api/providers/image-generation-providers.js');
  const { resolveImageGenerationParamSchema } = await import('../../src/scripts/ui/image-generation-params-utils.js');
  const v45 = { provider: 'novelai', model: 'nai-diffusion-4-5-full' };
  assert.equal(resolveImageReferenceCapability(v45).supported, false);
  assert.match(resolveImageReferenceCapability(v45, { preciseReference: 'off' }).reason, /打开「精准参考」.*5 Anlas/);
  assert.deepEqual([resolveImageReferenceCapability(v45, { preciseReference: 'character' }).supported, resolveImageReferenceCapability(v45, { preciseReference: 'character' }).max], [true, 1]);
  // V5 带精准参考会回 500（实测），不提供
  assert.match(resolveImageReferenceCapability({ provider: 'novelai', model: 'nai-diffusion-5-full' }, { preciseReference: 'character' }).reason, /只支持 V4\.5/);
  assert.equal(resolveImageGenerationParamSchema({ provider: 'novelai', model: 'nai-diffusion-5-full' }).fields.some(field => field.key === 'preciseReference'), false);
  assert.equal(resolveImageReferenceCapability({ provider: 'novelai', model: 'nai-diffusion-4-full' }, { preciseReference: 'character' }).supported, false);
  const fields = resolveImageGenerationParamSchema({ provider: 'novelai', model: 'nai-diffusion-4-5-full' }).fields;
  assert.deepEqual(['preciseReference', 'preciseReferenceStrength', 'preciseReferenceFidelity'].map(key => fields.find(field => field.key === key)?.defaultValue), ['off', 1, 1], 'precise reference is off by default');
  assert.equal(resolveImageGenerationParamSchema({ provider: 'novelai', model: 'nai-diffusion-3' }).fields.some(field => field.key === 'preciseReference'), false);

  assert.deepEqual([pickNovelAIReferenceSize(600, 1200), pickNovelAIReferenceSize(1600, 900), pickNovelAIReferenceSize(1000, 1000)], [[1024, 1536], [1536, 1024], [1472, 1472]]);
  const prepared = [];
  const provider = new NovelAIImageProvider({ apiKey: 'k', model: 'nai-diffusion-4-5-full', prepareReferenceImage: async (dataUrl) => { prepared.push(dataUrl); return 'PADDED'; } });
  const base = provider.buildPayload('1girl', {});
  const withRef = await provider.addPreciseReference(base, { preciseReference: 'character&style', preciseReferenceStrength: '0.8', preciseReferenceFidelity: 0.75, referenceImages: ['data:image/png;base64,Zmlyc3Q=', 'data:image/png;base64,c2Vjb25k'] });
  assert.deepEqual(prepared, ['data:image/png;base64,Zmlyc3Q='], 'only the first reference is used');
  const params = withRef.parameters;
  assert.deepEqual([params.director_reference_images, params.director_reference_descriptions, params.director_reference_information_extracted, params.director_reference_strength_values, params.director_reference_secondary_strength_values],
    [['PADDED'], [{ caption: { base_caption: 'character&style', char_captions: [] }, legacy_uc: false }], [1], [0.8], [0.25]]);
  assert.equal(params.prompt ?? withRef.input, base.input);
  assert.equal(await provider.addPreciseReference(base, { preciseReference: 'off', referenceImages: ['data:x'] }), base, 'off leaves the request alone');
  assert.equal(await provider.addPreciseReference(base, { preciseReference: 'character' }), base, 'no reference image, nothing added');
  const clamp = await provider.addPreciseReference(base, { preciseReference: 'character', preciseReferenceStrength: 7, referenceImages: [{ dataUrl: 'data:y' }] });
  assert.deepEqual([clamp.parameters.director_reference_strength_values, clamp.parameters.director_reference_secondary_strength_values], [[1], [0]]);
  console.log('ok - NovelAI precise reference is opt-in, uses the first image and sends the official fields');
}

console.log('chat-image-reference-pins-tests passed');
